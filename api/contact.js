// api/contact.js
// Vercel Serverless (CommonJS)

module.exports = async function handler(req, res) {
  const DEBUG = process.env.DEBUG === "1";
  const API_KEY = process.env.SYSTEME_API_KEY;
  const BASE = "https://api.systeme.io/api";

  function dbg(...args) { if (DEBUG) console.log(...args); }

  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  if (!API_KEY) return res.status(500).json({ error: "SYSTEME_API_KEY missing" });

  let body = {};
  try { body = typeof req.body === "object" ? req.body : JSON.parse(req.body); } catch(e){}

  let { email, first_name, score, tagNames } = body;
  if (!email) return res.status(400).json({ error: "email required" });

  email = email.trim().toLowerCase();
  first_name = first_name ? String(first_name).trim() : "";
  score = score ? String(score).trim() : null;

  if (!Array.isArray(tagNames)) tagNames = [tagNames].filter(Boolean);
  tagNames = tagNames.filter(Boolean).map(t => t.toLowerCase());
  if (!tagNames.includes("sadone")) tagNames.unshift("sadone");

  dbg("incoming:", { email, first_name, score, tagNames });

  async function sysFetch(path, opts={}) {
    const url = BASE + path;
    const headers = Object.assign({}, opts.headers||{}, { "X-API-Key": API_KEY });
    const resp = await fetch(url, { ...opts, headers });
    const text = await resp.text();
    let json = null; try { json = JSON.parse(text); } catch(e){}
    return { ok: resp.ok, status: resp.status, json, text };
  }

  try {
    // ---- 1) Find or create contact ----
    let contactId = null;
    const find = await sysFetch(`/contacts?email=${encodeURIComponent(email)}&limit=10`);
    if (find.ok && find.json) {
      const items = find.json.items || find.json.data || [];
      const match = items.find(i => (i.email||"").toLowerCase()===email);
      if (match) contactId = match.id;
    }

    if (!contactId) {
      const create = await sysFetch("/contacts", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          email,
          firstName: first_name || undefined,
          fields: score ? [{ slug:"score", value:score }] : []
        })
      });
      if (!create.ok) return res.status(500).json({ error:"Create failed", detail:create.text });
      contactId = create.json.id;
    } else {
      // PATCH update
      const patch = { firstName: first_name || undefined };
      if (score) patch.fields = [{ slug:"score", value:score }];
      const upd = await sysFetch(`/contacts/${contactId}`, {
        method:"PATCH",
        headers:{ "Content-Type":"application/merge-patch+json" },
        body: JSON.stringify(patch)
      });
      if (!upd.ok) return res.status(500).json({ error:"Update failed", detail:upd.text });
    }

    // ---- 2) Tags ----
    const tagsResp = await sysFetch("/tags?limit=500");
    const allTags = tagsResp.json.items || tagsResp.json.data || [];
    const tagMap = {}; allTags.forEach(t => tagMap[t.name.toLowerCase()] = t.id);

    const resolvedTagIds = [];
    for (const name of tagNames) {
      if (tagMap[name]) { resolvedTagIds.push(tagMap[name]); continue; }
      const create = await sysFetch("/tags", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ name })
      });
      if (create.ok && create.json.id) {
        resolvedTagIds.push(create.json.id);
      }
    }

    // Remove old assessment tags
    const contactResp = await sysFetch(`/contacts/${contactId}`);
    const currentTags = contactResp.json.contact?.tags || [];
    const assessment = new Set(["sadone","saresult1","saresult2","saresult3"]);
    for (const t of currentTags) {
      if (assessment.has(t.name.toLowerCase())) {
        await sysFetch(`/contacts/${contactId}/tags/${t.id}`, { method:"DELETE" });
      }
    }

    // Assign new
    const assigned = [];
    for (const tid of resolvedTagIds) {
      const assign = await sysFetch(`/contacts/${contactId}/tags`, {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ tagId: tid })
      });
      if (assign.ok) assigned.push(tid);
    }

    return res.json({ success:true, contactId, assignedTags: assigned });

  } catch(err) {
    console.error("server error", err);
    return res.status(500).json({ error:"Internal", detail: err.message });
  }
};
