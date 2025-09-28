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
    // Step 1: Find or create contact
    let contact = null;
    let contactId = null;

    // Try to find existing contact
    const findResp = await fetch(`${baseUrl}/contacts?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const findData = await findResp.json();
    if (findData && findData.data && findData.data.length > 0) {
      contact = findData.data[0];
      contactId = contact.id;
    }

    if (!contactId) {
      // Create new contact
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
      const createData = await createResp.json();
      contactId = createData.id;
      contact = createData;
    } else {
      // Update existing contact (PATCH)
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
    }

    // Step 2: Add tags
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
      contact,
      assignedTagIds,
      tagErrors,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
