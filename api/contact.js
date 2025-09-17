/**
 * api/contact.js - final update
 * - Ensures first name is saved for both new and existing contacts
 * - Stores score (fields.slug = "score")
 * - Ensures tags exist and assigns them
 * - Returns the updated contact (after tags)
 *
 * Expects POST JSON:
 * { "email": "...", "first_name": "...", "score": "...", "tagNames": ["sadone","saresult2"] }
 */

function parseJsonBody(req) {
  if (req && req.body && Object.keys(req.body).length) return req.body;
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString()));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const payload = await parseJsonBody(req);
    const { email, first_name, score, tagNames } = payload || {};

    if (!email) return res.status(400).json({ error: 'Missing email' });

    const apiKey = process.env.SYSTEME_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing SYSTEME_API_KEY' });

    const base = 'https://api.systeme.io/api';

    // 1) Fetch all tags (to get ids)
    const tagsResp = await fetch(`${base}/tags`, { headers: { 'X-API-Key': apiKey } });
    const tagsJson = await tagsResp.json();
    if (!tagsResp.ok) return res.status(502).json({ error: 'Failed to fetch tags', detail: tagsJson });

    const tagsMap = {};
    (tagsJson.items || []).forEach(t => { if (t && t.name) tagsMap[t.name] = t.id; });

    // 2) Ensure requested tag IDs exist (create missing tags)
    const tagIds = [];
    for (const name of (tagNames || [])) {
      if (!name) continue;
      if (tagsMap[name]) { tagIds.push(tagsMap[name]); continue; }

      const createTagResp = await fetch(`${base}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ name })
      });
      const created = await createTagResp.json();
      if (createTagResp.ok && created && created.id) {
        tagIds.push(created.id);
        tagsMap[name] = created.id;
      } else {
        return res.status(502).json({ error: 'Unable to create tag', name, detail: created });
      }
    }

    // 3) Check if contact exists (search by email)
    const searchResp = await fetch(`${base}/contacts?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-Key': apiKey }
    });
    const searchJson = await searchResp.json();
    if (!searchResp.ok) return res.status(502).json({ error: 'Failed to search contact', detail: searchJson });

    let contactId = null;
    if (Array.isArray(searchJson.items) && searchJson.items.length > 0) {
      contactId = searchJson.items[0].id;
    }

    let contactResult = null;

    // 4) Create or update contact
    const fieldsArray = [];
    // Ensure first_name is written as a custom field (slug 'first_name')
    if (typeof first_name !== 'undefined') {
      fieldsArray.push({ slug: 'first_name', value: String(first_name || '') });
    }
    // Ensure score is written as a custom field (slug 'score')
    if (typeof score !== 'undefined') {
      fieldsArray.push({ slug: 'score', value: String(score || '') });
    }

    if (!contactId) {
      // Create
      const createBody = {
        email,
        locale: 'en',
        fields: fieldsArray
      };
      // Also include top-level first_name just in case (safe)
      if (typeof first_name !== 'undefined') createBody.first_name = first_name || '';

      const createResp = await fetch(`${base}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(createBody)
      });
      const created = await createResp.json();
      if (!createResp.ok) return res.status(502).json({ error: 'Contact creation failed', detail: created });
      contactResult = created;
      contactId = created.id;
    } else {
      // Update existing contact — must use merge-patch content type for PATCH
      const updateBody = { fields: fieldsArray };
      // some clients also accept first_name top-level, but fields with slug is reliable
      if (typeof first_name !== 'undefined') updateBody.first_name = first_name || '';

      const updateResp = await fetch(`${base}/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', 'X-API-Key': apiKey },
        body: JSON.stringify(updateBody)
      });
      const updated = await updateResp.json();
      if (!updateResp.ok) return res.status(502).json({ error: 'Contact update failed', detail: updated });
      contactResult = updated;
    }

    // 5) Assign all requested tags (POST contacts/{id}/tags : { tagId: id })
    for (const id of tagIds) {
      await fetch(`${base}/contacts/${contactId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ tagId: id })
      });
    }

    // 6) Fetch updated contact (so response reflects newly added tags + fields)
    const finalResp = await fetch(`${base}/contacts/${contactId}`, {
      headers: { 'X-API-Key': apiKey }
    });
    const finalJson = await finalResp.json();
    if (!finalResp.ok) return res.status(502).json({ error: 'Failed to fetch updated contact', detail: finalJson });

    return res.status(200).json({ success: true, contact: finalJson, tagIds });

  } catch (err) {
    console.error('Server error', err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
