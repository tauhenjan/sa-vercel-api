/**
 * Vercel Serverless function: api/contact.js
 * - Accepts POST JSON: { email, first_name, score, tagNames: [...] }
 * - Ensures tags exist in Systeme.io (creates missing ones)
 * - Creates/updates contact with score stored as a field and adds tags
 *
 * IMPORTANT: Add your Systeme.io Public API key to Vercel env var named: SYSTEME_API_KEY
 */

function parseJsonBody(req) {
  // If req.body already exists (Next.js/Vercel will sometimes parse it) return it.
  if (req && req.body && Object.keys(req.body).length) return req.body;

  // Otherwise parse manually (robust for raw Node requests)
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
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
    console.log('Received payload:', payload); // Debug logging
    
    const { email, first_name, score, tagNames } = payload || {};

    if (!email) return res.status(400).json({ error: 'Missing email' });

    const apiKey = process.env.SYSTEME_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Server missing SYSTEME_API_KEY env var' });

    const base = 'https://api.systeme.io/api';

    // 1) Fetch existing tags
    const tagsResp = await fetch(`${base}/tags`, { headers: { 'X-API-Key': apiKey } });

    if (!tagsResp.ok) {
      const txt = await tagsResp.text();
      console.error('Failed to fetch tags', tagsResp.status, txt);
      return res.status(502).json({ error: 'Failed to fetch tags from Systeme.io', detail: txt });
    }

    const tagsJson = await tagsResp.json();
    const tagsMap = {};

    if (Array.isArray(tagsJson.items)) {
      tagsJson.items.forEach(t => { if (t && t.name) tagsMap[t.name] = t.id; });
    }

    console.log('Existing tags map:', tagsMap); // Debug logging

    // 2) Ensure tag IDs exist (create missing)
    const tagIds = [];

    for (const name of (tagNames || [])) {
      if (!name) continue;

      if (tagsMap[name]) {
        tagIds.push(tagsMap[name]);
        console.log(`Found existing tag: ${name} with ID: ${tagsMap[name]}`);
        continue;
      }

      // Create the tag
      console.log(`Creating new tag: ${name}`);
      const createTagResp = await fetch(`${base}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ name })
      });

      const created = await createTagResp.json();

      if (createTagResp.ok && created && created.id) {
        tagIds.push(created.id);
        tagsMap[name] = created.id;
        console.log(`Successfully created tag: ${name} with ID: ${created.id}`);
      } else {
        console.error('Unable to create tag', name, created);
        return res.status(502).json({ error: 'Unable to create tag', name, detail: created });
      }
    }

    console.log('Final tag IDs to assign:', tagIds);

    // 3) Create or update the contact - CORRECTED FIELD NAMES
    const contactBody = {
      email,
      first_name: first_name || '', // camelCase
      language: 'en',
      fields: [{ slug: 'first_name', value: String(firstName || '') }],
      fields: [{ slug: 'score', value: String(score || '') }],
      tagIds: tagIds // camelCase
    };
    console.log('Contact body to send:', contactBody); // Debug logging

    const contactResp = await fetch(`${base}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(contactBody)
    });

    const contactJson = await contactResp.text();

    if (!contactResp.ok) {
      console.error('Contact create/update failed', contactResp.status, contactJson);
      return res.status(502).json({ error: 'Failed to create/update contact', detail: contactJson });
    }

    console.log('Successfully created/updated contact'); // Debug logging

    // All good
    res.status(200).json({ success: true, detail: JSON.parse(contactJson) });

  } catch (err) {
    console.error('Server error', String(err));
    res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
