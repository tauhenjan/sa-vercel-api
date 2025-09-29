// api/contact.js
module.exports = async function handler(req, res) {
  const DEBUG = process.env.DEBUG === "1";
  const apiKey = process.env.SYSTEME_API_KEY;

  function dbg(...args) {
    if (DEBUG) console.log(...args);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!apiKey) {
    return res.status(500).json({ error: "Missing SYSTEME_API_KEY in env" });
  }

  const baseUrl = "https://api.systeme.io/api";
  const body = req.body || {};
  let { email, first_name, score, tagNames } = body;

  email = (email || "").toString().trim().toLowerCase();
  first_name = first_name ? String(first_name).trim() : "";
  score = (score === undefined || score === null) ? null : String(score).trim();

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  if (!tagNames) tagNames = [];
  if (!Array.isArray(tagNames)) tagNames = [String(tagNames)];
  tagNames = tagNames.map(t => (t || "").toString().trim()).filter(Boolean);

  // Ensure "sadone" is always present
  if (!tagNames.map(t => t.toLowerCase()).includes("sadone")) {
    tagNames.unshift("sadone");
  }

  // Deduplicate
  const seen = new Set();
  tagNames = tagNames.filter(t => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  dbg("incoming:", { email, first_name, score, tagNames });

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
    } catch {
      return { ok: resp.ok, status: resp.status, text, json: null };
    }
    return { ok: resp.ok, status: resp.status, text, json };
  }

  try {
    // 1) Fetch tags and normalize
    const tagsResp = await sysFetch("/tags?limit=500");
    let existingTags = [];
    if (tagsResp.ok && tagsResp.json) {
      if (Array.isArray(tagsResp.json)) {
        existingTags = tagsResp.json;
      } else if (Array.isArray(tagsResp.json.items)) {
        existingTags = tagsResp.json.items;
      } else if (Array.isArray(tagsResp.json.data)) {
        existingTags = tagsResp.json.data;
      } else {
        dbg("Unexpected tags response shape:", tagsResp.json);
      }
    }

    const tagNameToId = {};
    existingTags.forEach(t => {
      if (t && t.name && t.id) {
        tagNameToId[t.name.toLowerCase()] = t.id;
      }
    });

    // 2) Resolve tagIds (create if missing)
    const resolvedTagIds = [];
    const tagResolutionErrors = [];

    for (const tagName of tagNames) {
      const key = tagName.toLowerCase();
      if (tagNameToId[key]) {
        resolvedTagIds.push(tagNameToId[key]);
        continue;
      }

      const createTagResp = await sysFetch("/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tagName }),
      });

      if (createTagResp.ok && createTagResp.json) {
        const newTag = createTagResp.json;
        const newTagId = newTag.id || (newTag.data && newTag.data.id);
        if (newTagId) {
          tagNameToId[key] = newTagId;
          resolvedTagIds.push(newTagId);
        } else {
          tagResolutionErrors.push({ tagName, detail: newTag });
        }
      } else {
        tagResolutionErrors.push({ tagName, detail: createTagResp.text });
      }
    }

    // 3) Find or create contact
    let contactId = null;
    let contact = null;

    const findResp = await sysFetch(`/contacts?email=${encodeURIComponent(email)}&limit=1`);
    if (findResp.ok && findResp.json) {
      const items = findResp.json.items || findResp.json.data || findResp.json;
      if (Array.isArray(items) && items.length > 0) {
        contact = items[0];
        contactId = contact.id;
      }
    }

    let created = false;
    if (!contactId) {
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
        return res.status(500).json({ error: "Failed to create contact", detail: createResp.text });
      }
      const createdData = createResp.json;
      contactId = createdData.id;
      created = true;
    } else {
      const patchBody = { firstName: first_name || undefined };
      if (score !== null) {
        patchBody.fields = [{ slug: "score", value: score }];
      }
      const patchResp = await sysFetch(`/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify(patchBody),
      });
      if (!patchResp.ok) {
        return res.status(500).json({ error: "Failed to update contact", detail: patchResp.text });
      }
    }

    // 4) Get current tags on contact
    const contactResp = await sysFetch(`/contacts/${contactId}`);
    const freshContact = (contactResp.ok && contactResp.json)
      ? (contactResp.json.contact || contactResp.json)
      : null;
    const existingAssignedTags = Array.isArray(freshContact?.tags) ? freshContact.tags : [];

    // Filter only "assessment tags" (sadone + saresult1/2/3) to remove
    const assessmentTagIds = Object.entries(tagNameToId)
      .filter(([name]) => ["sadone", "saresult1", "saresult2", "saresult3"].includes(name))
      .map(([_, id]) => id);

    const removedTagIds = [];
    for (const t of existingAssignedTags) {
      const tid = t.id;
      if (assessmentTagIds.includes(tid)) {
        await sysFetch(`/contacts/${contactId}/tags/${tid}`, { method: "DELETE" });
        removedTagIds.push(tid);
      }
    }

    // 5) Assign new resolved assessment tags
    const assignedTagIds = [];
    for (const tid of resolvedTagIds) {
      const assignResp = await sysFetch(`/contacts/${contactId}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagId: tid }),
      });
      if (assignResp.ok) {
        assignedTagIds.push(tid);
      }
    }

    // 6) Return final
    const finalResp = await sysFetch(`/contacts/${contactId}`);
    const finalContact = (finalResp.ok && finalResp.json)
      ? (finalResp.json.contact || finalResp.json)
      : null;

    return res.json({
      success: true,
      created,
      contact: finalContact,
      resolvedTagIds,
      removedTagIds,
      assignedTagIds,
      tagResolutionErrors,
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
};
