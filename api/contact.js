const fetch = require("node-fetch");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, first_name, score, tagNames } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const apiKey = process.env.SYSTEME_API_KEY;
  const baseUrl = "https://api.systeme.io";

  try {
    // 1. Create or update contact (POST /contacts is idempotent in Systeme.io)
    const createResp = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        firstName: first_name,
        fields: [{ slug: "score", value: score }],
      }),
    });

    const contactData = await createResp.json();

    if (!contactData.id && !contactData.contact?.id) {
      return res.status(500).json({ error: "Failed to create or update contact", detail: contactData });
    }

    const contactId = contactData.id || contactData.contact.id;

    // 2. Add tags
    let assignedTagIds = [];
    let tagErrors = [];

    if (tagNames && tagNames.length > 0) {
      for (const tag of tagNames) {
        try {
          const resp = await fetch(`${baseUrl}/contacts/${contactId}/tags`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ tagName: tag }),
          });
          const data = await resp.json();
          if (data.id) {
            assignedTagIds.push(data.id);
          } else {
            tagErrors.push({ tag, detail: data });
          }
        } catch (err) {
          tagErrors.push({ tag, detail: err.message });
        }
      }
    }

    return res.json({
      success: true,
      contact: contactData.contact || contactData,
      assignedTagIds,
      tagErrors,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error", detail: error.message });
  }
};
