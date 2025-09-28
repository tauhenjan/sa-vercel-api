// api/contact.js
// Vercel Serverless function: robust create/update contact, ensure score & first_name, ensure tags
// Requirements: set SYSTEME_API_KEY in Vercel Environment Variables

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });

    const SYS_KEY = process.env.SYSTEME_API_KEY;
    if (!SYS_KEY) return res.status(500).json({ error: 'Server misconfigured: SYSTEME_API_KEY missing' });

    const BASE = 'https://api.systeme.io/api';

    // --- helper to call systeme.io and return parsed JSON if possible ---
    async function apiFetch(path, opts = {}) {
      const headers = Object.assign({}, opts.headers || {}, { 'X-API-Key': SYS_KEY });
      const fetchOpts = Object.assign({}, opts, { headers });
      const r = await fetch(`${BASE}${path}`, fetchOpts);
      const text = await r.text().catch(() => null);
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch(e) { json = text; }
      return { ok: r.ok, status: r.status, json, raw: text, res: r };
    }

    // --- parse incoming body flexibly ---
    const body = (typeof req.body === 'object' && req.body) ? req.body : JSON.parse(req.body || '{}');

    const emailRaw = (body.email || body.emailAddress || body.email_address || '').toString().trim();
    if (!emailRaw) return res.status(400).json({ error: 'email required in payload' });
    const email = emailRaw.toLowerCase();

    const first_name = (body.first_name || body.firstName || body.firstname || body.first || '').toString().trim() || null;

    let scoreRaw = body.score ?? body.Score ?? null;
    if (scoreRaw !== null && scoreRaw !== undefined) {
      const s = String(scoreRaw).trim();
      const m = s.match(/-?\d+/);
      scoreRaw = m ? String(parseInt(m[0], 10)) : s;
    } else {
      scoreRaw = null;
    }

    // incoming tags: prefer tagNames (strings), accept tagIds array too
    const incomingTagNames = Array.isArray(body.tagNames) ? body.tagNames.map(String) : (typeof body.tagNames === 'string' ? [body.tagNames] : []);
    const incomingTagIds = Array.isArray(body.tagIds) ? body.tagIds.map(n => Number(n)) : [];

    // ensure 'sadone' is always present as requested
    if (!incomingTagNames.map(n => (n||'').toLowerCase()).includes('sadone')) incomingTagNames.unshift('sadone');

    // --- 1) Search for contact by email ---
    const search = await apiFetch(`/contacts?email=${encodeURIComponent(email)}`, { method: 'GET' });
    if (!search.ok && search.status !== 404) {
      return res.status(500).json({ error: 'Failed searching contacts', detail: search.json || search.raw });
    }

    let contact = Array.isArray(search.json?.items) && search.json.items.length ? search.json.items[0] : null;
    let contactId = contact ? contact.id : null;

    // --- 2) Create contact if not found ---
    if (!contactId) {
      const createBody = { email };
      if (first_name) createBody.first_name = first_name;
      if (scoreRaw !== null) createBody.fields = [{ slug: 'score', value: String(scoreRaw) }];
      const createResp = await apiFetch('/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody)
      });
      if (!createResp.ok) return res.status(500).json({ error: 'Contact creation failed', detail: createResp.json || createResp.raw });
      contact = createResp.json;
      contactId = contact.id;
    } else {
      // for existing contact: ensure we have the full contact record (with tags & fields)
      const full = await apiFetch(`/contacts/${contactId}`, { method: 'GET' });
      contact = full.ok ? full.json : contact;
    }

    // --- 3) Update first_name and score if needed (PATCH using merge-patch) ---
    // Build patch body if any change needed
    const patchBody = {};
    if (first_name) patchBody.first_name = first_name;
    if (scoreRaw !== null) patchBody.fields = [{ slug: 'score', value: String(scoreRaw) }];

    if (Object.keys(patchBody).length) {
      // Always include slug 'first_name' in fields as well to keep custom field in sync
      if (first_name) {
        patchBody.fields = patchBody.fields || [];
        // ensure first_name slug present
        const hasFirstSlug = patchBody.fields.some(f => f.slug === 'first_name');
        if (!hasFirstSlug) patchBody.fields.push({ slug: 'first_name', value: String(first_name) });
      }

      const patchResp = await apiFetch(`/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json' },
        body: JSON.stringify(patchBody)
      });
      // If patch failed, we will attempt a safer approach below; but don't abort now
    }

    // Re-fetch contact to inspect fields & tags freshly
    let freshContactResp = await apiFetch(`/contacts/${contactId}`, { method: 'GET' });
    if (freshContactResp.ok && freshContactResp.json) contact = freshContactResp.json;

    // --- 4) Ensure score really updated (fallback clear+set if value differs) ---
    if (scoreRaw !== null) {
      const scoreField = Array.isArray(contact.fields) ? contact.fields.find(f => f.slug === 'score') : null;
      const existingScore = scoreField ? String(scoreField.value ?? '') : '';
      if (String(existingScore) !== String(scoreRaw)) {
        // clear then set
        await apiFetch(`/contacts/${contactId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify({ fields: [{ slug: 'score', value: null }] })
        }).catch(()=>{});
        await new Promise(r=>setTimeout(r, 400));
        const setResp = await apiFetch(`/contacts/${contactId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify({ fields: [{ slug: 'score', value: String(scoreRaw) }] })
        }).catch(()=>{});
        // refresh
        const refreshed = await apiFetch(`/contacts/${contactId}`, { method: 'GET' });
        if (refreshed.ok && refreshed.json) contact = refreshed.json;
      }
    }

    // Also ensure first_name top-level is in sync (some UI reads top-level)
    if (first_name) {
      const topFirst = (contact.first_name || contact.firstName || '') || '';
      const fieldFirst = (Array.isArray(contact.fields) && contact.fields.find(f=>f.slug==='first_name')?.value) || '';
      if (String(topFirst).trim() !== String(first_name).trim() || String(fieldFirst).trim() !== String(first_name).trim()) {
        await apiFetch(`/contacts/${contactId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify({ first_name: String(first_name), fields: [{ slug: 'first_name', value: String(first_name) }] })
        }).catch(()=>{});
        const ref2 = await apiFetch(`/contacts/${contactId}`, { method: 'GET' });
        if (ref2.ok && ref2.json) contact = ref2.json;
      }
    }

    // --- 5) Resolve tag names -> ids (create missing tags) ---
    const allT
