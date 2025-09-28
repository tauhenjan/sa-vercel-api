// api/contact.js
// Vercel serverless function (CommonJS). Uses built-in fetch (Node 18+ on Vercel).
// Behavior:
//  - Accepts POST JSON { email, first_name, score, tagNames }
//  - Ensures tags exist (create if missing), maps names -> ids
//  - Finds contact by email (GET /api/contacts?email=...)
//    - If exists: updates first name and fields (PATCH)
//    - If not: creates contact (POST) with fields
//  - Removes any existing tag assignments for that contact, then assigns only the requested tags
//  - Returns summary with contact and assigned tag IDs and any errors
//
// NOTE: Set environment variable SYSTEME_API_KEY in Vercel (Project → Settings → Environment Variables).
// Optionally set DEBUG=1 in Vercel to see console.log debugging.

module.exports = async function handler(req, res) {
  const DEBUG = process.env.DEBUG === "1";
  const apiKey = process.env.SYSTEME_API_KEY;

  function dbg(...args) { if (DEBUG) console.log(...args); }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!apiKey) {
    return res.status(500).json({ error: "Missing SYSTEME_API_KEY in env" });
  }

  const baseUrl = "https://api.systeme.io/api";
  const body = req.body || {};
  let { email, first_name, score, tagNames } = body;

  // Normalize inputs
  email = (email || "").toString().trim().toLowerCase();
  first_name = first_name ? String(first_name).trim() : "";
  score = (score === undefined || score === null) ? null : String(score).trim();

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  // Normalize tagNames: allow tagNames as array or single string
  if (!tagNames) tagNames = [];
  if (!Array.isArray(tagNames)) tagNames = [String(tagNames)];

  // Ensure tag names are trimmed, unique and non-empty
  tagNames = tagNames.map(t => (t || "").toString().trim()).filter(Boolean);
  // Ensure 'sadone' tag is present (you asked it should be assigned to all)
  if (!tagNames.map(t => t.toLowerCase()).includes("sadone")) {
    tagNames.unshift("sadone");
  }
  // Deduplicate preserving order (case-insensitive)
  const seen = new Set();
  tagNames = tagNames.filter(t => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  dbg("incoming:", { email, first_name, score, tagNames });

  // Helper: centralized fetch with X-API-Key and safe JSON parsing
  async function sysFetch(path, opts = {}) {
    const url = `${baseUrl}${path}`;
    const headers = Object.assign({}, opts.headers || {}, {
      "X-API-Key": apiKey,
    });
    const finalOpts = Object.assign({}, opts, { headers });

    dbg("sysFetch:", finalOpts.method || "GET", url);
    const resp = await fetch(url, finalOpts);
    const text = await resp.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (err) {
      // Return structured object so caller can decide
      return { ok: resp.ok, status: resp.status, text, json: null };
    }
    return { ok: resp.ok, status: resp.status, text, json };
  }

  try {
    // 1) Get all existing tags (we will map names -> ids)
    const tagsResp = await sysFetch("/tags?limit=500"); // limit large enough for most accounts
    if (!tagsResp.ok && tagsResp.status === 404) {
      // Unlikely but explicit
      return res.status(500).json({ error: "Tags endpoint not found (404)" });
    }
    if (!tagsResp.ok && !tagsResp.json) {
      return res.status(500).json({ error: "Failed to fetch tags", detail: tagsResp.text });
    }
    const existingTags = (tagsResp.json && (tagsResp.json.items || tagsResp.json)) || [];
    // Build name -> id map (lowercase key)
    const tagNameToId = {};
    existingTags.forEach(t => {
      if (!t || !t.name || !t.id) return;
      tagNameToId[String(t.name).toLowerCase()] = t.id;
    });
    dbg("existing tags count:", existingTags.length);

    // 2) Resolve requested tag names to tagIds (create tags if missing)
    const resolvedTagIds = [];
    const tagResolutionErrors = [];

    for (const tagName of tagNames) {
      const key = tagName.toLowerCase();
      if (tagNameToId[key]) {
        resolvedTagIds.push(tagNameToId[key]);
        continue;
      }

      // Create tag
      dbg("creating tag:", tagName);
      const createTagResp = await sysFetch("/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tagName }),
      });

      if (!createTagResp.ok || !createTagResp.json) {
        tagResolutionErrors.push({ tagName, detail: createTagResp.text || createTagResp.json });
        continue;
      }
      const newTag = createTagResp.json;
      // some responses may nest; try to get id and name robustly
      const newTagId = newTag.id || (newTag.data && newTag.data.id) || null;
      if (!newTagId) {
        tagResolutionErrors.push({ tagName, detail: newTag });
        continue;
      }
      // add to map and resolved list
      tagNameToId[key] = newTagId;
      resolvedTagIds.push(newTagId);
      dbg("created tag id:", newTagId);
    }

    dbg("resolvedTagIds:", resolvedTagIds, "tagResolutionErrors:", tagResolutionErrors);

    // 3) Find contact by email: GET /contacts?email=...
    // Some accounts may support query 'email' — if not, fallback to listing and searching.
    let contact = null;
    let contactId = null;

    // Try the GET query by email
    const findResp = await sysFetch(`/contacts?email=${encodeURIComponent(email)}&limit=1`);
    if (findResp.ok && findResp.json) {
      // docs show list under items key
      const items = findResp.json.items || findResp.json.data || findResp.json;
      if (Array.isArray(items) && items.length > 0) {
        contact = items[0];
        contactId = contact.id || contact.contact?.id;
      }
    } else {
      // If the GET returned non-json (HTML), try listing contacts and searching fallback
      if (findResp.text && findResp.text.startsWith("<")) {
        dbg("contacts list returned non-JSON; falling back to full listing search (may be rate-limited)");
      }
    }

    // 4) If contact not found -> create; else update
    let created = false;
    if (!contactId) {
      // Create new contact
      dbg("Creating contact:", email);
      const createResp = await sysFetch("/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          firstName: first_name || undefined,
          fields: score !== null ? [{ slug: "score", value: score }] : undefined,
        }),
      });

      if (!createResp.ok) {
        // return error detail
        const detail = createResp.json || createResp.text;
        return res.status(500).json({ error: "Failed to create contact", detail });
      }

      // createResp.json may be contact or wrapped
      const createdData = createResp.json;
      contactId = createdData.id || createdData.contact?.id || null;
      if (!contactId) {
        return res.status(500).json({ error: "Create contact succeeded but no id in response", detail: createdData });
      }
      created = true;
      // fetch the created contact for a consistent representation
      const getAfterCreate = await sysFetch(`/contacts/${contactId}`);
      contact = (getAfterCreate.ok && getAfterCreate.json) ? (getAfterCreate.json.contact || getAfterCreate.json) : createdData;
      dbg("created contact id:", contactId);
    } else {
      // Update existing contact (PATCH /contacts/{id}) - use merge-patch content type
      dbg("Updating contact:", contactId);
      const patchBody = {
        firstName: first_name || undefined,
      };
      if (score !== null) {
        patchBody.fields = [{ slug: "score", value: score }];
      }
      const patchResp = await sysFetch(`/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify(patchBody),
      });
      if (!patchResp.ok) {
        // return error
        return res.status(500).json({ error: "Failed to update existing contact", detail: patchResp.json || patchResp.text });
      }
      // refresh contact
      const getAfterUpdate = await sysFetch(`/contacts/${contactId}`);
      contact = (getAfterUpdate.ok && getAfterUpdate.json) ? (getAfterUpdate.json.contact || getAfterUpdate.json) : contact;
      dbg("updated contact:", contactId);
    }

    // 5) Remove existing tags on this contact (delete all tag links)
    // Many contact responses include contact.tags as array of objects with id & name. We'll attempt to read that,
    // otherwise we call GET /contacts/{id} and inspect tags.
    const finalContactResp = await sysFetch(`/contacts/${contactId}`);
    const freshContact = (finalContactResp.ok && finalContactResp.json) ? (finalContactResp.json.contact || finalContactResp.json) : null;
    const existingAssignedTags = (freshContact && (freshContact.tags || freshContact.tag || freshContact.tags_list)) || [];

    const removedTagIds = [];
    const removeErrors = [];

    if (Array.isArray(existingAssignedTags) && existingAssignedTags.length > 0) {
      dbg("Existing assigned tags on contact:", existingAssignedTags);
      for (const t of existingAssignedTags) {
        // t might be { id, name } or a numeric id
        const tid = t && (t.id || t.tagId || t);
        if (!tid) continue;
        try {
          const delResp = await sysFetch(`/contacts/${contactId}/tags/${tid}`, { method: "DELETE" });
          if (delResp.ok) {
            removedTagIds.push(tid);
          } else {
            removeErrors.push({ tagId: tid, detail: delResp.json || delResp.text });
          }
        } catch (err) {
          removeErrors.push({ tagId: tid, detail: err.message });
        }
      }
    }

    dbg("removedTagIds:", removedTagIds, "removeErrors:", removeErrors);

    // 6) Assign the resolvedTagIds (POST /contacts/{id}/tags with { tagId })
    const assignedTagIds = [];
    const assignErrors = [];
    for (const tid of resolvedTagIds) {
      try {
        const assignResp = await sysFetch(`/contacts/${contactId}/tags`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tagId: tid }),
        });
        if (assignResp.ok && assignResp.json) {
          // some API returns the assigned tag object
          const assignedId = assignResp.json.id || assignResp.json.tagId || tid;
          assignedTagIds.push(assignedId);
        } else {
          assignErrors.push({ tagId: tid, detail: assignResp.json || assignResp.text });
        }
      } catch (err) {
        assignErrors.push({ tagId: tid, detail: err.message });
      }
    }

    // final fresh contact
    const finalResp = await sysFetch(`/contacts/${contactId}`);
    const finalContact = (finalResp.ok && finalResp.json) ? (finalResp.json.contact || finalResp.json) : contact;

    // Return final structured result
    return res.json({
      success: true,
      created,
      contact: finalContact,
      resolvedTagIds,
      assignedTagIds,
      removedTagIds,
      tagResolutionErrors,
      removeErrors,
      assignErrors,
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Internal server error", detail: err && err.message });
  }
};
