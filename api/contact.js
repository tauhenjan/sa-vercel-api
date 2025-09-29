// api/contact.js
// Vercel Serverless (CommonJS). Copy/paste whole file and commit to GitHub.
// Uses built-in fetch (Node 18+ on Vercel).
// ENV: set SYSTEME_API_KEY in Vercel. Optionally set DEBUG=1 to see logs.

module.exports = async function handler(req, res) {
  const DEBUG = process.env.DEBUG === "1";
  const API_KEY = process.env.SYSTEME_API_KEY || process.env.SIO_API_KEY || process.env.SIO_KEY;
  const BASE = "https://api.systeme.io/api";

  function dbg(...args) { if (DEBUG) console.log(...args); }

  // --- robust body parsing: handles parsed req.body or raw stream or urlencoded ---
  async function getBody() {
    // If already parsed (Vercel often parses JSON), use it
    if (req.body && Object.keys(req.body || {}).length > 0) {
      return req.body;
    }
    // Otherwise read raw stream
    let raw = "";
    try {
      for await (const chunk of req) raw += chunk;
    } catch (e) {
      // ignore
    }
    if (!raw) return {};
    const ct = (req.headers && req.headers["content-type"]) ? req.headers["content-type"].toLowerCase() : "";
    // try JSON
    try {
      return JSON.parse(raw);
    } catch (e) {}
    // try urlencoded
    if (ct.includes("application/x-www-form-urlencoded") || raw.includes("=")) {
      const params = new URLSearchParams(raw);
      const obj = {};
      for (const [k, v] of params) obj[k] = v;
      return obj;
    }
    // fallback: return raw under "raw"
    return { raw };
  }

  // --- safe systeme fetch: returns { ok, status, json, text } ---
  async function sysFetch(path, opts = {}) {
    const url = `${BASE}${path}`;
    const headers = Object.assign({}, opts.headers || {}, { "X-API-Key": API_KEY });
    const finalOpts = Object.assign({}, opts, { headers });
    dbg("sysFetch:", finalOpts.method || "GET", url);
    const resp = await fetch(url, finalOpts);
    const text = await resp.text().catch(() => null);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { ok: resp.ok, status: resp.status, json, text };
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed — use POST" });
  if (!API_KEY) return res.status(500).json({ error: "Missing SYSTEME_API_KEY in environment" });

  try {
    const body = await getBody();
    dbg("parsed body:", body);

    let email = (body.email || "").toString().trim();
    let first_name = body.first_name || body.firstName || body["first-name"] || "";
    first_name = first_name ? String(first_name).trim() : "";
    let score = (body.score === undefined || body.score === null) ? null : String(body.score).trim();

    // Accept tagNames either as array or single value
    let tagNames = body.tagNames || body.tags || [];
    if (!Array.isArray(tagNames)) {
      if (typeof tagNames === "string" && tagNames.length) tagNames = [tagNames];
      else tagNames = [];
    }
    tagNames = tagNames.map(t => (t || "").toString().trim()).filter(Boolean);

    if (!email) {
      return res.status(400).json({ error: "email required" });
    }
    email = email.toLowerCase();

    // Ensure 'sadone' present and dedupe (case-insensitive)
    if (!tagNames.map(t => t.toLowerCase()).includes("sadone")) tagNames.unshift("sadone");
    const seen = new Set();
    tagNames = tagNames.filter(t => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    dbg("incoming normalized:", { email, first_name, score, tagNames });

    // ---------- 1) find existing contact ----------
    let contactId = null;
    // systeme requires limit >= 10
    const findResp = await sysFetch(`/contacts?email=${encodeURIComponent(email)}&limit=10`);
    dbg("findResp status:", findResp.status);
    if (findResp.ok && findResp.json) {
      const items = Array.isArray(findResp.json) ? findResp.json : (findResp.json.items || findResp.json.data || []);
      if (Array.isArray(items) && items.length > 0) {
        // prefer exact email match
        const match = items.find(i => (i.email || "").toString().toLowerCase() === email) || items[0];
        contactId = match.id || match.contact?.id || null;
      }
    } else {
      // Not ok — but continue with fallback attempts later if needed
      dbg("findResp text:", findResp.text);
    }

    // fallback: if not found, search first 100 contacts
    if (!contactId) {
      const fallback = await sysFetch(`/contacts?limit=100`);
      if (fallback.ok && fallback.json) {
        const items = Array.isArray(fallback.json) ? fallback.json : (fallback.json.items || fallback.json.data || []);
        if (Array.isArray(items) && items.length > 0) {
          const match = items.find(i => (i.email || "").toString().toLowerCase() === email);
          if (match) contactId = match.id || match.contact?.id || null;
        }
      }
    }
    dbg("contactId after lookup:", contactId);

    // ---------- 2) create or update contact ----------
    if (!contactId) {
      // try to create
      const createResp = await sysFetch("/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          // include both keys to be maximally compatible
          firstName: first_name || undefined,
          first_name: first_name || undefined,
          fields: (score !== null) ? [{ slug: "score", value: score }] : undefined
        })
      });

      if (!createResp.ok) {
        // If create failed because the email already exists, attempt fallback search to find the ID
        const text = createResp.text || JSON.stringify(createResp.json || {});
        dbg("createResp failed:", createResp.status, text);
        if (createResp.status === 422 && text && text.includes("already used")) {
          // fallback: search contacts up to 500 and find email
          const fb = await sysFetch(`/contacts?limit=500`);
          if (fb.ok && fb.json) {
            const items = Array.isArray(fb.json) ? fb.json : (fb.json.items || fb.json.data || []);
            const match = Array.isArray(items) ? items.find(i => (i.email || "").toLowerCase() === email) : null;
            if (match) contactId = match.id || match.contact?.id || null;
            dbg("fallback found contactId:", contactId);
          }
          if (!contactId) {
            return res.status(500).json({ error: "Create failed", status: createResp.status, detail: text });
          }
        } else {
          return res.status(500).json({ error: "Create failed", status: createResp.status, detail: text });
        }
      } else {
        contactId = (createResp.json && (createResp.json.id || createResp.json.contact?.id)) || null;
        if (!contactId) {
          return res.status(500).json({ error: "Create succeeded but no contact id returned", detail: createResp.json || createResp.text });
        }
      }
    } else {
      // PATCH update existing contact
      const patchBody = {};
      // include both forms of the name to maximize compatibility (Systeme can accept camelCase or snake_case)
      patchBody.firstName = first_name || undefined;
      patchBody.first_name = first_name || undefined;
      if (score !== null) patchBody.fields = [{ slug: "score", value: score }];
      const patchResp = await sysFetch(`/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify(patchBody)
      });
      if (!patchResp.ok) {
        return res.status(500).json({ error: "Update failed", status: patchResp.status, detail: patchResp.text || patchResp.json });
      }
    }

    dbg("contactId final:", contactId);

    // ---------- 3) TAGS: get existing tags and map names -> ids ----------
    const tagsResp = await sysFetch(`/tags?limit=500`);
    const existingTagsArray = (tagsResp.ok && tagsResp.json)
      ? (Array.isArray(tagsResp.json) ? tagsResp.json : (tagsResp.json.items || tagsResp.json.data || []))
      : [];
    const tagNameToId = {};
    existingTagsArray.forEach(t => { if (t && t.name && t.id) tagNameToId[t.name.toLowerCase()] = t.id; });

    const resolvedTagIds = [];
    const tagErrors = [];
    for (const tname of tagNames) {
      const key = tname.toLowerCase();
      if (tagNameToId[key]) { resolvedTagIds.push(tagNameToId[key]); continue; }

      // Try to create tag
      const createTagResp = await sysFetch("/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tname })
      });

      if (createTagResp.ok && createTagResp.json) {
        const newId = createTagResp.json.id || createTagResp.json.data?.id;
        if (newId) {
          tagNameToId[key] = newId;
          resolvedTagIds.push(newId);
          continue;
        }
      }

      // If create failed due to "already used", re-fetch tags and try to find ID
      const createText = createTagResp ? (createTagResp.text || JSON.stringify(createTagResp.json || {})) : "";
      dbg("createTagResp failed:", createTagResp && createTagResp.status, createText);
      if (createTagResp && createTagResp.status === 422 && createText.includes("already used")) {
        // re-fetch tags then lookup
        const reTags = await sysFetch("/tags?limit=500");
        const arr = (reTags.ok && reTags.json) ? (Array.isArray(reTags.json) ? reTags.json : (reTags.json.items || reTags.json.data || [])) : [];
        const found = arr.find(x => (x.name||"").toLowerCase() === key);
        if (found && found.id) {
          tagNameToId[key] = found.id;
          resolvedTagIds.push(found.id);
          continue;
        }
      }

      // Otherwise record error
      tagErrors.push({ tag: tname, detail: createTagResp ? (createTagResp.json || createTagResp.text) : "unknown error" });
    }

    dbg("resolvedTagIds:", resolvedTagIds, "tagErrors:", tagErrors);

    // ---------- 4) Remove only assessment tags from the contact (leave others intact) ----------
    const contactResp = await sysFetch(`/contacts/${contactId}`);
    const contactObj = (contactResp.ok && contactResp.json) ? (contactResp.json.contact || contactResp.json) : null;
    const assigned = Array.isArray(contactObj?.tags) ? contactObj.tags : [];
    const assessmentSet = new Set(["sadone", "saresult1", "saresult2", "saresult3"]);

    const removedTagIds = [];
    for (const t of assigned) {
      const tname = (t.name || "").toString().toLowerCase();
      if (assessmentSet.has(tname) || tname.startsWith("saresult")) {
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

    // final contact fetch
    const finalResp = await sysFetch(`/contacts/${contactId}`);
    const finalContact = (finalResp.ok && finalResp.json) ? (finalResp.json.contact || finalResp.json) : null;

    // return structured result
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
    console.error("server error:", err && (err.stack || err));
    return res.status(500).json({ error: "Internal server error", detail: (err && err.message) ? err.message : String(err) });
  }
};
