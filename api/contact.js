// api/contact.js

module.exports = async function handler(req, res) {
  const apiKey = process.env.SYSTEME_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing SYSTEME_API_KEY" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const baseUrl = "https://api.systeme.io/api";
  const { email, first_name, score, tagNames = [] } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  async function sysFetch(path, opts = {}) {
    const resp = await fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        "X-API-Key": apiKey,
        "Content-Type": opts.body
          ? opts.headers?.["Content-Type"] || "application/json"
          : undefined,
      },
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // leave json null if parsing fails
    }
    return { ok: resp.ok, status: resp.status, json, text };
  }

  try {
    // 1. Try to find contact by email
    let contactId = null;
    const findResp = await sysFetch(
      `/contacts?email=${encodeURIComponent(email)}&limit=10`
    );

    if (findResp.ok && findResp.json) {
      let items = [];
      if (Array.isArray(findResp.json)) {
        items = findResp.json;
      } else if (findResp.json.items) {
        items = findResp.json.items;
      } else if (findResp.json.data) {
        items = findResp.json.data;
      }
      if (Array.isArray(items) && items.length > 0) {
        contactId = items[0].id;
      }
    }

    if (!contactId) {
      return res.status(404).json({
        error: "No contact found for this email",
        raw: findResp.json,
      });
    }

    // 2. Update existing contact
const patchResp = await sysFetch(`/contacts/${contactId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/merge-patch+json" },
  body: JSON.stringify({
    first_name, // use snake_case
    fields: [
      { slug: "score", value: score }
    ]
  }),
});


    if (!patchResp.ok) {
      return res.status(500).json({
        error: "Update failed",
        status: patchResp.status,
        detail: patchResp.text,
      });
    }

    // 3. Done
    return res.json({
      success: true,
      contactId,
      email,
      first_name,
      score,
      tagNames,
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
};
