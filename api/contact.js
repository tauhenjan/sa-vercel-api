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

  // ---- Helper fetch
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
      // ignore parse errors
    }
    return { ok: resp.ok, status: resp.status, json, text };
  }

  try {
    // 1. Try to find contact by email
    let contactId = null;
    const findResp = await sysFetch(
      `/contacts?email=${encodeURIComponent(email)}&limit=1`
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

    // Debug: return raw lookup if no contactId found
    if (!contactId) {
      return res.status(200).json({
        debug: "Lookup failed → no contactId",
        raw: findResp.json,
      });
    }

    // 2. Update existing contact (never create duplicate)
    const patchResp = await sysFetch(`/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/merge-patch+json" },
      body: JSON.stringify({
        firstName: first_name,
        fields: [{ slug: "score", value: score }],
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
