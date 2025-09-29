// api/contact.js
// Vercel serverless function to sync Typebot → Systeme.io
// Requires env var: SYSTEME_API_KEY

module.exports = async function handler(req, res) {

const API_KEY = process.env.SYSTEME_API_KEY;

const BASE = "https://api.systeme.io/api";

async function readBody() {

if (req.body && Object.keys(req.body).length > 0) return req.body;

let raw = "";

for await (const chunk of req) raw += chunk;

return raw ? JSON.parse(raw) : {};

}

async function sysFetch(path, opts = {}) {

const url = `${BASE}${path}`;

const headers = { ...(opts.headers || {}), "X-API-Key": API_KEY };

const resp = await fetch(url, { ...opts, headers });

const text = await resp.text().catch(() => "");

let json = null;

try { json = text ? JSON.parse(text) : null; } catch {}

console.log("sysFetch:", opts.method || "GET", url, "→", resp.status);

return { ok: resp.ok, status: resp.status, json, text };

}

if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

if (!API_KEY) return res.status(500).json({ error: "Missing SYSTEME_API_KEY" });

try {

const body = await readBody();

const email = (body.email || "").trim().toLowerCase();

if (!email) return res.status(400).json({ error: "email required" });

const first_name = (body.first_name || "").trim();

const score = body.score !== undefined ? String(body.score).trim() : null;

let tagNames = Array.isArray(body.tagNames) ? body.tagNames : [body.tagNames];

tagNames = tagNames.filter(Boolean).map(t => t.trim());

if (!tagNames.includes("sadone")) tagNames.unshift("sadone");

console.log("normalized:", { email, first_name, score, tagNames });

// --- 1) Find contact ---

let contactId = null;

const findResp = await sysFetch(`/contacts?email=${encodeURIComponent(email)}&limit=10`);

if (findResp.ok && findResp.json) {

const items = findResp.json.items || findResp.json.data || [];

if (items.length > 0) contactId = items[0].id;

}

// --- 2) Create or update contact ---

if (!contactId) {

const createResp = await sysFetch("/contacts", {

method: "POST",

headers: { "Content-Type": "application/json" },

body: JSON.stringify({

email,

fields: [

...(first_name ? [{ slug: "first_name", value: first_name }] : []),

...(score ? [{ slug: "score", value: score }] : [])

]

})

});

if (!createResp.ok) {

return res.status(500).json({ error: "Create failed", detail: createResp.text });

}

contactId = createResp.json.id;

} else {

const patchResp = await sysFetch(`/contacts/${contactId}`, {

method: "PATCH",

headers: { "Content-Type": "application/merge-patch+json" },

body: JSON.stringify({

fields: [

...(first_name ? [{ slug: "first_name", value: first_name }] : []),

...(score ? [{ slug: "score", value: score }] : [])

]

})

});

if (!patchResp.ok) {

return res.status(500).json({ error: "Update failed", detail: patchResp.text });

}

}

// --- 3) Resolve tag IDs (fix: use limit=100) ---

const tagsResp = await sysFetch("/tags?limit=100");

const existing = tagsResp.ok && tagsResp.json ? (tagsResp.json.items || tagsResp.json.data || []) : [];

const tagMap = {};

existing.forEach(t => { tagMap[t.name.toLowerCase()] = t.id; });

const resolvedTagIds = [];

const tagErrors = [];

for (const tname of tagNames) {

const key = tname.toLowerCase();

if (tagMap[key]) {

resolvedTagIds.push(tagMap[key]);

} else {

tagErrors.push({ tag: tname, detail: "Tag not found" });

}

}

// --- 4) Remove only assessment tags ---

const cResp = await sysFetch(`/contacts/${contactId}`);

const contactObj = cResp.json.contact || cResp.json;

const existingTags = contactObj.tags || [];

const removeSet = new Set(["sadone","saresult1","saresult2","saresult3"]);

const removedTagIds = [];

for (const t of existingTags) {

if (removeSet.has(t.name.toLowerCase())) {

await sysFetch(`/contacts/${contactId}/tags/${t.id}`, { method: "DELETE" });

removedTagIds.push(t.id);

}

}

// --- 5) Assign new tags (FIXED: use tag_id instead of tagId) ---

const assignedTagIds = [];

const assignErrors = [];

for (const tid of resolvedTagIds) {

const assign = await sysFetch(`/contacts/${contactId}/tags`, {

method: "POST",

headers: { "Content-Type": "application/json" },

body: JSON.stringify({ tag_id: tid })

});

if (assign.ok) assignedTagIds.push(tid);

else assignErrors.push({ tagId: tid, detail: assign.text });

}

// --- 6) Final fetch ---

const finalResp = await sysFetch(`/contacts/${contactId}`);

const finalContact = finalResp.json.contact || finalResp.json;

return res.json({

success: true,

contactId,

removedTagIds,

assignedTagIds,

tagErrors,

assignErrors,

contact: finalContact

});

} catch (err) {

console.error("Handler error:", err);

return res.status(500).json({ error: "Internal error", detail: err.message });

}

};
