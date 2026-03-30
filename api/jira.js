export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  if (req.headers["x-token"] !== process.env.SECRET) {
  return res.status(403).end();
}

  try {
    const issue = req.body.issue;

    const message = {
      content: `🆕 ${issue.key} - ${issue.fields.summary}`
    };

    await fetch(process.env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message)
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro interno" });
  }
}
