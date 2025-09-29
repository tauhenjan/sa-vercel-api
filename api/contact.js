// api/contact.js
// Vercel Serverless (CommonJS). Uses built-in fetch (Node 18+ on Vercel).
// Accepts POST JSON: { email, first_name, score, tagNames: ["sadone","saresult2"] }

module.exports = async function handler(req, res) {
  const DEBUG = process.env.DEBUG === "1";
  const API_KEY = process.env.SYSTEME_API_KEY || process.env.SIO_API_KEY || process.env.SIO_KEY;
  const BASE = "https://api.systeme.io/api";

  function dbg(...args) { if (DEBUG) console.log(...args); }

  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed - use POST" });
  if (!API_KEY) return res.status(500).json({ error: "SYSTEME API key missing. Set SYSTEME_API_KEY in Vercel" });

  // parse body safely (Vercel usually already parsed JSON)
  let body = {};
  try { body = (typeof req.body === "object" && req.body) ? req.body : JSON.parse(req.body || "{}"); } catch(e) { body = {}; }

  let { email, first_name, score, tagNames } = body;
  email = (email || "").toString().trim().toLowerCase();
  first_name = first_name ? String(first_name).trim() : "";
  score = (score === undefined || score === null) ? null : String(score).trim();

  if (!email) return res.status(400).json({ error: "email is required" });

  // normalize tagNames input
  if (!tagNames) tagNames = [];
  if (!Array.isArray(tagNames)) tagNames = [String(tagNames || "")];
  tagNames = tagNames.map(t => (t||"").toString().trim()).filter(Boolean);

  // ensure 'sadone' present
  if (!tagNames.map(t=>t.toLowerCase()).includes("sadone")) tagNames.unshift("sadone");

  // dedupe preserving order (case-insensitive)
  const seen = new Set();
  tagNames = tagNames.filter(t => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  dbg("incoming:", { email, first_name, score, tagNames });

  // wrapper for Systeme.io fetch: returns { ok, status, json, text }
  async function sysFetch(path, opts = {}) {
    const url = `${BASE}${path}`;
    const headers = Object.assign({}, opts.headers || {}, { "X-API-Key": API_KEY });
    const finalOpts = Object.assign({}, opts, { headers });
    dbg("sysFetch:", finalOpts.method || "GET", url);
    const resp = await fetch(url, finalOpts);
    const text = await resp.text().catch(()=>null);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { ok: resp.ok, status: resp.status, json, text };
  }

  try {
    // ---------- 1) FIND CONTACT ----------
    // Use limit=10 (Systeme requires >=10). We'll search first page for a matching email.
    const findResp = await sysFetch(`/contacts?email=${encodeURIComponent(email)}&limit=10`);
    dbg("findResp status:", findResp.status);

    let contactId = null;
    if (findResp.ok && findResp.json) {
      // items may be in items, data, or the json itself may be array
      const items = Array.isArray(findResp.json) ? findResp.json
                    : (findResp.json.items || findResp.json.data || []);
      if (Array.isArray(items) && items.length > 0) {
        // pick the first exact match for email (safety)
        const match = items.find(i => (i.email||"").toString().toLowerCase() === email) || items[0];
        contactId = match && (match.id || match.contact?.id) ? (match.id || match.contact.id) : null;
      }
    }

    // If contactId still null, try a broader fallback (fetch up to 100 and search) — handles inconsistent API shapes
    if (!contactId) {
      const fallback = await sysFetch(`/contacts?limit=100`);
      if (fallback.ok && fallback.json) {
        const items = Array.isArray(fallback.json) ? fallback.json : (fallback.json.items || fallback.json.data || []);
        if (Array.isArray(items) && items.length > 0) {
          const match = items.find(i => (i.email||"").toString().toLowerCase() === email);
          if (match) contactId = match.id || match.contact?.id || null;
        }
      }
    }

    dbg("resolved contactId:", contactId);

    // ---------- 2) CREATE or UPDATE contact ----------
    if (!contactId) {
      // Try to create. If API says "email already used" we will fallback to find the contact ID and then PATCH.
      const createResp = await sysFetch("/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          first_name: first_name || undefined,
          fields: score !== null ? [{ slug: "score", value: score }] : undefined
        }),
      });

      if (!createResp.ok) {
        // If 422 and email already used, fallback to searching (race / inconsistent list behavior)
        const text = createResp.text || JSON.stringify(createResp.json);
        if (createResp.status === 422 && text && text.includes("This value is already used")) {
          dbg("Create returned email-used. Attempting fallback search...");
          const fallback2 = await sysFetch(`/contacts?limit=100`);
          if (fallback2.ok && fallback2.json) {
            const items = Array.isArray(fallback2.json) ? fallback2.json : (fallback2.json.items || fallback2.json.data || []);
            const match = Array.isArray(items) ? items.find(i => (i.email||"").toString().toLowerCase() === email) : null;
            if (match) {
              contactId = match.id || match.contact?.id || null;
              dbg("Fallback found contactId:", contactId);
            }
          }
          if (!contactId) {
            return res.status(500).json({ error: "Create failed", status: createResp.status, detail: text });
          }
        } else {
          return res.status(500).json({ error: "Create failed", status: createResp.status, detail: createResp.text || createResp.json });
        }
      } else {
        // success
        contactId = createResp.json && (createResp.json.id || createResp.json.contact?.id) ? (createResp.json.id || createResp.json.contact.id) : null;
        if (!contactId) {
          // unexpected shape
          return res.status(500).json({ error: "Create succeeded but no contact id returned", detail: createResp.json || createResp.text });
        }
      }
    } else {
      // existing -> PATCH update
      const patchBody = { first_name: first_name || undefined };
      if (score !== null) patchBody.fields = [{ slug: "score", value: score }];
      const patchResp = await sysFetch(`/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify(patchBody),
      });
      if (!patchResp.ok) {
        return res.status(500).json({ error: "Update failed", status: patchResp.status, detail: patchResp.text || patchResp.json });
      }
    }

    dbg("contactId final:", contactId);

    // ---------- 3) TAGS: resolve names -> ids (create missing) ----------
    const tagsResp = await sysFetch(`/tags?limit=500`);
    const existingTagsArray = (tagsResp.ok && tagsResp.json)
      ? (Array.isArray(tagsResp.json) ? tagsResp.json : (tagsResp.json.items || tagsResp.json.data || []))
      : [];
    const tagNameToId = {};
    existingTagsArray.forEach(t => { if (t && t.name && t.id) tagNameToId[t.name.toLowerCase()] = t.id; });

    const resolvedTagIds = [];
    const tagErrors = [];
    for (const tname of tagNames) {
      const key = (tname||"").toLowerCase();
      if (tagNameToId[key]) { resolvedTagIds.push(tagNameToId[key]); continue; }
      // create missing tag
      const createTag = await sysFetch("/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tname })
      });
      if (createTag.ok && createTag.json) {
        const newId = createTag.json.id || createTag.json.data?.id || null;
        if (newId) {
          tagNameToId[key] = newId;
          resolvedTagIds.push(newId);
        } else {
          tagErrors.push({ tag: tname, detail: createTag.json || createTag.text });
        }
      } else {
        tagErrors.push({ tag: tname, detail: createTag.text || createTag.json });
      }
    }

    dbg("resolvedTagIds:", resolvedTagIds, "tagErrors:", tagErrors);

    // ---------- 4) Remove only assessment tags from the contact (leave other tags alone) ----------
    const contactResp = await sysFetch(`/contacts/${contactId}`);
    const contactObj = (contactResp.ok && contactResp.json) ? (contactResp.json.contact || contactResp.json) : null;
    const assigned = Array.isArray(contactObj?.tags) ? contactObj.tags : [];

    const assessmentSet = new Set(["sadone", "saresult1", "saresult2", "saresult3"]);
    const removedTagIds = [];
    for (const t of assigned) {
      const tname = (t.name || "").toString().toLowerCase();
      if (assessmentSet.has(tname) || tname.startsWith("saresult")) {
        // try delete
        const tid = t.id || t.tagId || null;
        if (!tid) continue;
        const del = await sysFetch(`/contacts/${contactId}/tags/${tid}`, { method: "DELETE" });
        if (del.ok) removedTagIds.push(tid);
      }
    }

    // ---------- 5) Assign desired tags ----------
    const assignedTagIds = [];
    const assignErrors = [];
    for (const tid of resolvedTagIds) {
      const assign = await sysFetch(`/contacts/${contactId}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagId: tid })
      });
      if (assign.ok) assignedTagIds.push(tid);
      else assignErrors.push({ tagId: tid, detail: assign.text || assign.json });
    }

    // final fetch for returning canonical contact
    const finalResp = await sysFetch(`/contacts/${contactId}`);
    const finalContact = (finalResp.ok && finalResp.json) ? (finalResp.json.contact || finalResp.json) : null;

    return res.json({
      success: true,
      contactId,
      finalContact,
      resolvedTagIds,
      assignedTagIds,
      removedTagIds,
      tagErrors,
      assignErrors
    });

  } catch (err) {
    console.error("server error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Internal server error", detail: (err && err.message) ? err.message : String(err) });
  }
};
