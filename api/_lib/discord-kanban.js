import { formatIssueGroups, listProjectIssues } from "./jira-client.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const KANBAN_HEADER = "Quadro Kanban";

export async function syncKanbanMessage() {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_KANBAN_CHANNEL_ID;

  if (!botToken || !channelId) {
    return;
  }

  const issues = await listProjectIssues();
  const content = buildKanbanContent(issues);
  const existingMessage = await findKanbanMessage(channelId, botToken);

  if (existingMessage) {
    await discordRequest(`/channels/${channelId}/messages/${existingMessage.id}`, {
      method: "PATCH",
      botToken,
      body: { content }
    });
    return;
  }

  const created = await discordRequest(`/channels/${channelId}/messages`, {
    method: "POST",
    botToken,
    body: { content }
  });

  try {
    await discordRequest(`/channels/${channelId}/pins/${created.id}`, {
      method: "PUT",
      botToken
    });
  } catch (error) {
    console.error("Nao foi possivel fixar a mensagem do quadro:", error.message);
  }
}

function buildKanbanContent(issues) {
  const updatedAt = new Date().toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo"
  });

  return truncate(
    [`${KANBAN_HEADER}`, `Atualizado em: ${updatedAt}`, "", formatIssueGroups(issues)].join("\n"),
    1900
  );
}

async function findKanbanMessage(channelId, botToken) {
  const pinned = await discordRequest(`/channels/${channelId}/pins`, {
    method: "GET",
    botToken
  }).catch(() => []);

  const pinnedMatch = pinned.find((message) => message.content?.startsWith(KANBAN_HEADER));
  if (pinnedMatch) {
    return pinnedMatch;
  }

  const recentMessages = await discordRequest(`/channels/${channelId}/messages?limit=20`, {
    method: "GET",
    botToken
  }).catch(() => []);

  return recentMessages.find((message) => message.content?.startsWith(KANBAN_HEADER)) || null;
}

async function discordRequest(path, { method = "GET", botToken, body } = {}) {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    throw new Error(payload?.message || text || `Discord respondeu com status ${response.status}`);
  }

  return payload;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
