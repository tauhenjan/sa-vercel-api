/**
 * api/contact.js - Final Version
 * Safely create or update Systeme.io contact, store score, and assign tags.
 */

function parseJsonBody(req) {
  if (req && req.body && Object.keys(req.body).length) return req.body;
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString()));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
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

    // --- 1) Fetch existing tags ---
    const tagsResp = await fetch(`${base}/tags`, { headers: { 'X-API-Key': apiKey } });
    const tagsJson = await tagsResp.json();
    if (!tagsResp.ok) return res.status(502).json({ error: 'Failed to fetch tags', detail: tagsJson });

    const tagsMap = {};
    (tagsJson.items || []).forEach(t => {
      if (t && t.name) tagsMap[t.name] = t.id;
    });

    // --- 2) Ensure tag IDs exist ---
    const tagIds = [];
    for (const name of tagNames || []) {
      if (!name) continue;
      if (tagsMap[name]) {
        tagIds.push(tagsMap[name]);
        continue;
      }
      const createTagResp = await fetch(`${base}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ name })
      });
      const created = await createTagResp.json();
      if (createTagResp.ok && created.id) {
        tagIds.push(created.id);
        tagsMap[name] = created.id;
      } else {
        return res.status(502).json({ error: 'Unable to create tag', name, detail: created });
      }
    }

    // --- 3) Check if contact exists ---
    const searchResp = await fetch(`${base}/contacts?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-Key': apiKey }
    });
    const searchJson = await searchResp.json();

    let contactId = null;
    if (searchResp.ok && Array.isArray(searchJson.items) && searchJson.items.length > 0) {
      contactId = searchJson.items[0].id;
    }

    // --- 4) Create or update contact ---
    let contactResult = null;
    if (!contactId) {
      // CREATE new contact
      const createResp = await fetch(`${base}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          email,
          first_name: first_name || '',
          language: 'en',
          fields: [{ slug: 'score', value: String(score || '') }]
        })
      });
      const created = await createResp.json();
      if (!createResp.ok) return res.status(502).json({ error: 'Contact creation failed', detail: created });
      contactResult = created;
      contactId = created.id;
    } else {
      // UPDATE existing contact (using merge-patch)
      const updateResp = await fetch(`${base}/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          first_name: first_name || '',
          fields: [{ slug: 'score', value: String(score || '') }]
        })
      });
      const updated = await updateResp.json();
      if (!updateResp.ok) return res.status(502).json({ error: 'Contact update failed', detail: updated });
      contactResult = updated;
    }

    // --- 5) Assign tags ---
    for (const id of tagIds) {
      await fetch(`${base}/contacts/${contactId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ tagId: id })
      });
    }

    return res.status(200).json({ success: true, contact: contactResult, tagIds });
  } catch (err) {
    console.error('Server error', err);
    res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
