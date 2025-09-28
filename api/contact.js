module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, first_name, score, tagIds } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const apiKey = process.env.SYSTEME_API_KEY;
  const baseUrl = "https://api.systeme.io";

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

    const createData = await createResp.json();

    if (!createData.id && !createData.contact?.id) {
      return res.status(500).json({
        error: "Failed to create or update contact",
        detail: createData,
      });
    }

    const contactId = createData.id || createData.contact.id;

    // 2. Explicitly update score (PATCH)
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
          const data = await resp.json();
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
      contact: createData.contact || createData,
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
