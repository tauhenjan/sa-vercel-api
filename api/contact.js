import fetch from "node-fetch";

const API_BASE = "https://api.systeme.io/api";
const API_KEY = process.env.SIO_API_KEY; // set in Vercel environment

async function sysFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const opts = {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  };
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("Non-JSON response from Systeme.io:", text);
    throw new Error("Systeme.io did not return JSON");
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { email, first_name, score, tagNames = [] } = req.body;

    // 1. Fetch tags & map names → IDs
    const allTags = await sysFetch("/tags?limit=100");
    const tagMap = {};
    if (allTags.data) {
      allTags.data.forEach((t) => {
        tagMap[t.name] = t.id;
      });
    }
    const tagIds = tagNames
      .map((n) => tagMap[n])
      .filter((id) => id !== undefined);

    // 2. Lookup contact by email
    const lookup = await sysFetch(`/contacts?email=${encodeURIComponent(email)}&limit=10`);
    let contactId = lookup?.data?.[0]?.id;

    if (!contactId) {
      // 3a. Create new contact
      const create = await sysFetch("/contacts", {
        method: "POST",
        body: JSON.stringify({
          email,
          first_name,
          fields: [{ slug: "score", value: score }],
          tagIds,
        }),
      });
      if (!create.id) throw new Error("Create failed");
      contactId = create.id;
    } else {
      // 3b. Update existing contact
      await sysFetch(`/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify({
          first_name,
          fields: [{ slug: "score", value: score }],
        }),
      });

      if (tagIds.length) {
        await sysFetch(`/contacts/${contactId}/tags`, {
          method: "POST",
          body: JSON.stringify({ tagIds }),
        });
      }
    }

    res.json({
      success: true,
      contactId,
      email,
      first_name,
      score,
      tagIds,
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
}
