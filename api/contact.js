module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, first_name, score, tagIds } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const apiKey = process.env.SYSTEME_API_KEY;
  const baseUrl = "https://api.systeme.io/api/v1";

  try {
    // 1. Create or update contact
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

    let bodyText = await createResp.text();
    let contactData;

    try {
      contactData = JSON.parse(bodyText);
    } catch (err) {
      return res.status(500).json({
        error: "Systeme.io did not return JSON",
        detail: bodyText,
      });
    }

    if (!contactData.id && !contactData.contact?.id) {
      return res.status(500).json({
        error: "Failed to create or update contact",
        detail: contactData,
      });
    }

    const contactId = contactData.id || contactData.contact.id;

    // 2. Update score explicitly (PATCH ensures overwrite)
    await fetch(`${baseUrl}/contacts/${contactId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/merge-patch+json",
      },
      body: JSON.stringify({
        firstName: first_name,
        fields: [{ slug: "score", value: score }],
      }),
    });

    // 3. Add tags
    let assignedTagIds = [];
    let tagErrors = [];

    if (tagIds && tagIds.length > 0) {
      for (const tagId of tagIds) {
        try {
          const resp = await fetch(`${baseUrl}/contacts/${contactId}/tags`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ tagId }),
          });
          let tagBody = await resp.text();
          let data;
          try {
            data = JSON.parse(tagBody);
          } catch (err) {
            tagErrors.push({ tagId, detail: tagBody });
            continue;
          }
          if (data.id) {
            assignedTagIds.push(data.id);
          } else {
            tagErrors.push({ tagId, detail: data });
          }
        } catch (err) {
          tagErrors.push({ tagId, detail: err.message });
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
    return res
      .status(500)
      .json({ error: "Internal server error", detail: error.message });
  }
};
