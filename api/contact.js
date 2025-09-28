// api/contact.js
// Vercel Serverless function to create/update a contact in systeme.io, update 'score' field and assign tags.
// Requires env var SYSTEME_API_KEY set in Vercel project settings.

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed - use POST' });
    }

    const SYS_KEY = process.env.SYSTEME_API_KEY;
    if (!SYS_KEY) return res.status(500).json({ error: 'Server misconfigured: SYSTEME_API_KEY missing' });

    const base = 'https://api.systeme.io/api';

    // === Parse incoming body (be forgiving) ===
    const body = (typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}');

    const emailRaw = (body.email || body.emailAddress || body.email_address || '').toString().trim();
    if (!emailRaw) return res.status(400).json({ error: 'email required in payload' });
    const email = emailRaw.toLowerCase();

    const firstName = (body.firstName || body.first_name || body.firstname || body.first || '').toString().trim() || undefined;
    // Score: try to parse to integer-ish string; allow "85", 85, "85.0"
    let scoreRaw = body.score ?? body.Score ?? body.sov_score ?? null;
    if (scoreRaw !== null && scoreRaw !== undefined) {
      scoreRaw = String(scoreRaw).trim();
      // extract digits / optional decimal; prefer integer
      const m = scoreRaw.match(/-?\d+/);
      scoreRaw = m ? String(parseInt(m[0], 10)) : String(scoreRaw);
    } else {
      scoreRaw = null;
    }

    // Tags: accept tagNames: ["sadone","saresult2"] OR tagIds: [123,456] OR tagNames string
    const incomingTagNames = Array.isArray(body.tagNames) ? body.tagNames.map(String) :
                             typeof body.tagNames === 'string' ? [body.tagNames] : [];
    const incomingTagIds = Array.isArray(body.tagIds) ? body.tagIds.map(x => Number(x)) : [];

    // Always ensure 'sadone' is present as a name in tag list (user requested this)
    if (!incomingTagNames.map(n => n.toLowerCase()).includes('sadone')) incomingTagNames.unshift('sadone');

    // Helper: low-level fetch
    async function apiFetch(path, opts = {}) {
      const h = Object.assign({}, opts.headers || {}, { 'X-API-Key': SYS_KEY });
      const fetchOpts = Object.assign({}, opts, { headers: h });
      const r = await fetch(`${base}${path}`, fetchOpts);
      let text;
      try { text = await r.text(); } catch(e) { text = null; }
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch(e) { json = text; }
      return { ok: r.ok, status: r.status, json, raw: text, resObj: r };
    }

    // 1) Find existing contact by email
    const search = await apiFetch(`/contacts?email=${encodeURIComponent(email)}`, { method: 'GET' });
    if (!search.ok && search.status !== 404) {
      // tolerate a 404 as "not found", otherwise error
      // return error details for debugging
      return res.status(500).json({ error: 'Failed searching contacts', detail: search.json || search.raw });
    }

    let contact = (Array.isArray(search.json?.items) && search.json.items.length) ? search.json.items[0] : null;

    // 2) Create if missing
    if (!contact) {
      const createBody = {
        email,
      };
      if (firstName) createBody.first_name = firstName;
      if (scoreRaw !== null) createBody.fields = [{ slug: 'score', value: String(scoreRaw) }];
      const createResp = await apiFetch('/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody)
      });
      if (!createResp.ok) {
        return res.status(500).json({ error: 'Failed to create contact', detail: createResp.json || createResp.raw });
      }
      contact = createResp.json;
    } else {
      // 3) Update existing contact: try PATCH (merge-patch)
      const patchBody = {};
      if (firstName) patchBody.first_name = firstName;
      if (scoreRaw !== null) patchBody.fields = [{ slug: 'score', value: String(scoreRaw) }];

      // Only call PATCH if there is something to update (name or score)
      if (Object.keys(patchBody).length) {
        const patchResp = await apiFetch(`/contacts/${contact.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify(patchBody)
        });

        // If the PATCH failed or the field didn't change, we'll fetch and try a fallback below
        if (!patchResp.ok) {
          // continue to fallback logic (we won't abort yet)
        }
      }

      // fetch fresh contact after patch attempt
      const fresh = await apiFetch(`/contacts/${contact.id}`, { method: 'GET' });
      if (fresh.ok && fresh.json) contact = fresh.json;
    }

    // 4) Ensure score actually updated (robustness fallback)
    // If we have desired score and contact.fields does not include it, try clearing then setting (some users reported inconsistent behavior)
    if (scoreRaw !== null) {
      const existingScoreField = Array.isArray(contact.fields) ? contact.fields.find(f => f.slug === 'score') : null;
      const existingScoreValue = existingScoreField ? String(existingScoreField.value ?? '') : '';
      if (String(existingScoreValue) !== String(scoreRaw)) {
        // Try clearing first
        await apiFetch(`/contacts/${contact.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify({ fields: [{ slug: 'score', value: null }] })
        });
        // small delay to give Systeme a moment (rare race)
        await new Promise(r => setTimeout(r, 400));
        // set value again
        const setResp = await apiFetch(`/contacts/${contact.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify({ fields: [{ slug: 'score', value: String(scoreRaw) }] })
        });
        if (!setResp.ok) {
          // not fatal — include detail in response
        }
        // refresh contact
        const refreshed = await apiFetch(`/contacts/${contact.id}`, { method: 'GET' });
        if (refreshed.ok && refreshed.json) contact = refreshed.json;
      }
    }

    // 5) Prepare tag IDs to assign:
    // - existing numeric tagIds passed in are honored
    // - incomingTagNames (strings) will be resolved to tag IDs (create tag if missing)
    // Get current tag list (server-side) - attempt to fetch tags list once to match names
    const allTagsResp = await apiFetch('/tags?limit=500', { method: 'GET' });
    let tagNameToId = {};
    if (allTagsResp.ok && Array.isArray(allTagsResp.json?.items)) {
      for (const t of allTagsResp.json.items) tagNameToId[t.name.toLowerCase()] = Number(t.id);
    }

    const wantedTagIds = new Set((incomingTagIds || []).filter(n => !!n).map(n => Number(n)));

    for (const tnameRaw of incomingTagNames) {
      const tname = String(tnameRaw || '').trim();
      if (!tname) continue;
      const lower = tname.toLowerCase();
      if (tagNameToId[lower]) {
        wantedTagIds.add(tagNameToId[lower]);
      } else {
        // create tag
        const createTagResp = await apiFetch('/tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tname })
        });
        if (createTagResp.ok && createTagResp.json && createTagResp.json.id) {
          const tid = Number(createTagResp.json.id);
          wantedTagIds.add(tid);
          tagNameToId[lower] = tid;
        } else {
          // skip if tag creation failed (we'll include errors later)
        }
      }
    }

    // 6) Assign missing tags to contact
    const contactTagIds = new Set(Array.isArray(contact.tags) ? contact.tags.map(t => Number(t.id)) : []);
    const toAssign = [];
    for (const tid of Array.from(wantedTagIds)) {
      if (!contactTagIds.has(tid)) toAssign.push(tid);
    }

    const assigned = [];
    const tagErrors = [];
    for (const tid of toAssign) {
      const addResp = await apiFetch(`/contacts/${contact.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: Number(tid) })
      });
      if (addResp.ok) assigned.push(tid);
      else tagErrors.push({ tagId: tid, status: addResp.status, detail: addResp.json || addResp.raw });
    }

    // final fetch to return canonical contact state
    const finalContactResp = await apiFetch(`/contacts/${contact.id}`, { method: 'GET' });
    const finalContact = finalContactResp.ok ? finalContactResp.json : contact;

    // 7) Done — return helpful debug info
    return res.status(200).json({
      success: true,
      contact: finalContact,
      assignedTagIds: assigned,
      tagErrors,
    });

  } catch (err) {
    console.error('contact-api error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'internal_server_error', detail: String(err && err.message ? err.message : err) });
  }
}
