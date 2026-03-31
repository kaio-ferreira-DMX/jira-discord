import crypto from "crypto";

import {
  createIssue,
  deleteIssue,
  formatIssueGroups,
  formatIssue,
  getIssue,
  listProjectIssues,
  updateIssue
} from "./_lib/jira-client.js";

const DISCORD_PING = 1;
const DISCORD_APPLICATION_COMMAND = 2;
const DISCORD_PONG_RESPONSE = 1;
const DISCORD_MESSAGE_RESPONSE = 4;
const EPHEMERAL_FLAG = 64;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

let cachedPublicKey;

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "Discord interactions online. Use POST."
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const rawBody = await readRawBody(req);

    if (!verifyDiscordRequest(req, rawBody)) {
      return res.status(401).send("invalid request signature");
    }

    const interaction = JSON.parse(rawBody);

    if (interaction.type === DISCORD_PING) {
      return res.status(200).json({ type: DISCORD_PONG_RESPONSE });
    }

    if (interaction.type !== DISCORD_APPLICATION_COMMAND) {
      return sendMessage(res, "Tipo de interacao nao suportado.");
    }

    const result = await handleCommand(interaction);
    return sendMessage(res, result);
  } catch (error) {
    console.error("Discord interaction error:", error);
    return sendMessage(
      res,
      `Erro: ${error.message || "Falha ao processar o comando."}`
    );
  }
}

async function handleCommand(interaction) {
  const commandName = interaction.data?.name;

  if (commandName !== "jira") {
    throw new Error('Comando invalido. Registre o comando "/jira".');
  }

  const subcommand = getSubcommand(interaction.data?.options || []);

  switch (subcommand.name) {
    case "criar":
      return handleCreate(subcommand.options);
    case "ver":
      return handleRead(subcommand.options);
    case "ver_todos":
      return handleListAll();
    case "atualizar":
      return handleUpdate(subcommand.options);
    case "deletar":
      return handleDelete(subcommand.options);
    default:
      throw new Error("Subcomando nao suportado.");
  }
}

async function handleCreate(options) {
  const result = await createIssue({
    summary: getOptionValue(options, "titulo"),
    description: getOptionValue(options, "descricao"),
    assignee: getOptionValue(options, "responsavel"),
    discordUserId: getOptionValue(options, "responsavel_discord"),
    dueDate: getOptionValue(options, "data_limite"),
    issueType: getOptionValue(options, "tipo")
  });

  return [`Issue criada com sucesso.`, buildIssueLink(result.issue), formatIssue(result.issue)].join(
    "\n"
  );
}

async function handleRead(options) {
  const issue = await getIssue(getOptionValue(options, "chave"));
  return [buildIssueLink(issue), formatIssue(issue)].join("\n");
}

async function handleListAll() {
  const issues = await listProjectIssues();
  return formatIssueGroups(issues);
}

async function handleUpdate(options) {
  const result = await updateIssue(getOptionValue(options, "chave"), {
    summary: getOptionValue(options, "titulo"),
    description: getOptionValue(options, "descricao"),
    assignee: getOptionValue(options, "responsavel"),
    discordUserId: getOptionValue(options, "responsavel_discord"),
    dueDate: getOptionValue(options, "data_limite")
  });

  return [
    `Issue atualizada com sucesso.`,
    buildIssueLink(result.issue),
    formatIssue(result.issue)
  ].join("\n");
}

async function handleDelete(options) {
  const issueKey = getOptionValue(options, "chave");
  await deleteIssue(issueKey);
  return `Issue ${issueKey} deletada com sucesso.`;
}

function getSubcommand(options) {
  const subcommand = options.find((option) => option.type === 1);

  if (!subcommand) {
    throw new Error("Subcomando nao informado.");
  }

  return subcommand;
}

function getOptionValue(options, name) {
  return options.find((option) => option.name === name)?.value;
}

function sendMessage(res, content) {
  return res.status(200).json({
    type: DISCORD_MESSAGE_RESPONSE,
    data: {
      content: truncate(content, 1900),
      flags: EPHEMERAL_FLAG
    }
  });
}

async function readRawBody(req) {
  if (typeof req.rawBody === "string") {
    return req.rawBody;
  }

  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody.toString("utf8");
  }

  if (typeof req.body === "string") {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }

  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function verifyDiscordRequest(req, rawBody) {
  const publicKeyHex = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKeyHex) {
    throw new Error("Env ausente: DISCORD_PUBLIC_KEY");
  }

  const signature =
    req.headers["x-signature-ed25519"] || req.headers["X-Signature-Ed25519"];
  const timestamp =
    req.headers["x-signature-timestamp"] || req.headers["X-Signature-Timestamp"];

  if (!signature || !timestamp) {
    return false;
  }

  const message = Buffer.from(`${timestamp}${rawBody}`);
  const signatureBuffer = Buffer.from(signature, "hex");

  return crypto.verify(null, message, getDiscordPublicKey(publicKeyHex), signatureBuffer);
}

function getDiscordPublicKey(publicKeyHex) {
  if (cachedPublicKey) return cachedPublicKey;

  const keyBytes = Buffer.from(publicKeyHex, "hex");
  cachedPublicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
    format: "der",
    type: "spki"
  });

  return cachedPublicKey;
}

function buildIssueLink(issue) {
  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
  return baseUrl ? `${baseUrl}/browse/${issue.key}` : issue.key;
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
