/**
 * api/contact.js - with console.log() debugging
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
    console.log('🔵 Incoming payload:', JSON.stringify(payload, null, 2));

    const { email, first_name, score, tagNames } = payload || {};
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const apiKey = process.env.SYSTEME_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing SYSTEME_API_KEY' });

    const base = 'https://api.systeme.io/api';

    // 1) Fetch tags
    const tagsResp = await fetch(`${base}/tags`, { headers: { 'X-API-Key': apiKey } });
    const tagsJson = await tagsResp.json();
    console.log('🔵 Fetched tags count:', tagsJson.items?.length || 0);

    const tagsMap = {};
    (tagsJson.items || []).forEach(t => { if (t && t.name) tagsMap[t.name] = t.id; });

    // 2) Ensure requested tag IDs exist
    const tagIds = [];
    for (const name of (tagNames || [])) {
      if (!name) continue;
      if (tagsMap[name]) { tagIds.push(tagsMap[name]); continue; }
      console.log(`🟠 Creating missing tag: ${name}`);
      const createTagResp = await fetch(`${base}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ name })
      });
      const created = await createTagResp.json();
      console.log('🔵 Tag creation result:', created);
      if (createTagResp.ok && created && created.id) {
        tagIds.push(created.id);
        tagsMap[name] = created.id;
      } else {
        return res.status(502).json({ error: 'Unable to create tag', name, detail: created });
      }
    }
    console.log('✅ Final tagIds to attach:', tagIds);

    // 3) Check if contact exists
    const searchResp = await fetch(`${base}/contacts?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-Key': apiKey }
    });
    const searchJson = await searchResp.json();
    console.log('🔵 Search result count:', searchJson.items?.length || 0);

    let contactId = null;
    if (Array.isArray(searchJson.items) && searchJson.items.length > 0) {
      contactId = searchJson.items[0].id;
      console.log('🔵 Existing contact ID:', contactId);
    }

    let contactResult = null;
    const fieldsArray = [];
    if (typeof first_name !== 'undefined')
      fieldsArray.push({ slug: 'first_name', value: String(first_name || '') });
    if (typeof score !== 'undefined')
      fieldsArray.push({ slug: 'score', value: String(score || '') });

    if (!contactId) {
      console.log('🟢 Creating new contact...');
      const createBody = {
        email,
        locale: 'en',
        fields: fieldsArray
      };
      if (typeof first_name !== 'undefined') createBody.first_name = first_name || '';

      const createResp = await fetch(`${base}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(createBody)
      });
      const created = await createResp.json();
      console.log('🔵 Create contact response:', created);
      if (!createResp.ok) return res.status(502).json({ error: 'Contact creation failed', detail: created });
      contactResult = created;
      contactId = created.id;
    } else {
      console.log('🟡 Updating existing contact...');
      const updateBody = { fields: fieldsArray };
      if (typeof first_name !== 'undefined') updateBody.first_name = first_name || '';

      const updateResp = await fetch(`${base}/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', 'X-API-Key': apiKey },
        body: JSON.stringify(updateBody)
      });
      const updated = await updateResp.json();
      console.log('🔵 Update contact response:', updated);
      if (!updateResp.ok) return res.status(502).json({ error: 'Contact update failed', detail: updated });
      contactResult = updated;
    }

    // 5) Assign tags
    for (const id of tagIds) {
      console.log(`🔵 Assigning tagId ${id} to contactId ${contactId}`);
      await fetch(`${base}/contacts/${contactId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ tagId: id })
      });
    }

    // 6) Fetch updated contact (to confirm)
    const finalResp = await fetch(`${base}/contacts/${contactId}`, {
      headers: { 'X-API-Key': apiKey }
    });
    const finalJson = await finalResp.json();
    console.log('✅ Final contact object:', finalJson);

    return res.status(200).json({ success: true, contact: finalJson, tagIds });

  } catch (err) {
    console.error('❌ Server error', err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
