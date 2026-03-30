export default async function handler(req, res) {
  // 🔹 Só aceita POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // 🔹 Validação do token (só se existir SECRET)
  if (process.env.SECRET) {
    const token = req.headers["x-token"];

    if (!token || token !== process.env.SECRET) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  try {
    console.log("BODY:", req.body);

    const webhookEvent = req.body?.webhookEvent || "";
    const issue = req.body?.issue;

    if (!issue) {
      return res.status(400).json({ error: "Payload inválido" });
    }

    const issueKey = issue.key || issue.id || "Issue sem chave";
    const summary = issue.fields?.summary || "Sem resumo";

    let prefix = "🔔";
    if (webhookEvent.includes("issue_created")) prefix = "🆕";
    if (webhookEvent.includes("issue_updated")) prefix = "✏️";
    if (webhookEvent.includes("issue_deleted")) prefix = "🗑️";

    const message = {
      content: `${prefix} ${issueKey} - ${summary}`
    };

    const discordResponse = await fetch(process.env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message)
    });

    // 🔹 Debug se Discord falhar
    if (!discordResponse.ok) {
      const text = await discordResponse.text();
      console.error("Erro Discord:", text);
      return res.status(500).json({ error: "Erro ao enviar pro Discord" });
    }

    return res.status(200).json({ ok: true, webhookEvent });

  } catch (err) {
    console.error("ERRO:", err);
    return res.status(500).json({ error: err.message });
  }
}
