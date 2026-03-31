const JIRA_API_BASE = "/rest/api/3";

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Env ausente: ${name}`);
  }

  return value;
}

function getJiraConfig() {
  return {
    baseUrl: getRequiredEnv("JIRA_BASE_URL").replace(/\/$/, ""),
    email: getRequiredEnv("JIRA_EMAIL"),
    apiToken: getRequiredEnv("JIRA_API_TOKEN"),
    projectKey: getRequiredEnv("JIRA_PROJECT_KEY"),
    defaultIssueType: process.env.JIRA_DEFAULT_ISSUE_TYPE || "Task",
    discordJiraUserMap: safeJsonParse(process.env.DISCORD_JIRA_USER_MAP || "{}") || {}
  };
}

function getAuthHeader(email, apiToken) {
  const token = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return `Basic ${token}`;
}

async function jiraRequest(path, { method = "GET", body, query } = {}) {
  const { baseUrl, email, apiToken } = getJiraConfig();
  const url = new URL(`${baseUrl}${JIRA_API_BASE}${path}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: getAuthHeader(email, apiToken),
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const message =
      payload?.errorMessages?.join(", ") ||
      payload?.errors?.summary ||
      payload?.message ||
      text ||
      `Jira respondeu com status ${response.status}`;

    throw new Error(message);
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

function textToAdf(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: text
          ? [
              {
                type: "text",
                text
              }
            ]
          : []
      }
    ]
  };
}

function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.type === "text") return node.text || "";
  return adfToText(node.content);
}

function normalizeDueDate(value) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (["-", "none", "null", "nenhum"].includes(trimmed.toLowerCase())) {
    return null;
  }

  const brazilianFormat = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brazilianFormat) {
    const [, day, month, year] = brazilianFormat;
    return `${year}-${month}-${day}`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error("A data_limite precisa estar no formato YYYY-MM-DD ou DD/MM/YYYY.");
  }

  return trimmed;
}

async function resolveAssignee(assignee, discordUserId) {
  const { projectKey, discordJiraUserMap } = getJiraConfig();

  if (discordUserId) {
    const mappedValue = discordJiraUserMap[discordUserId];

    if (!mappedValue) {
      throw new Error(
        `Nao encontrei mapeamento para o usuario do Discord ${discordUserId}. Configure DISCORD_JIRA_USER_MAP com esse ID.`
      );
    }

    if (mappedValue.startsWith("id:")) {
      return { accountId: mappedValue.slice(3).trim() };
    }

    const mappedUsers = await jiraRequest("/user/assignable/search", {
      query: {
        project: projectKey,
        query: mappedValue
      }
    });

    if (!Array.isArray(mappedUsers) || mappedUsers.length === 0) {
      throw new Error(`Nao encontrei responsavel no Jira para o mapeamento "${mappedValue}".`);
    }

    return {
      accountId: mappedUsers[0].accountId,
      displayName: mappedUsers[0].displayName
    };
  }

  if (!assignee) return undefined;

  const value = assignee.trim();
  if (!value) return undefined;
  if (["-", "none", "null", "nenhum", "ninguem"].includes(value.toLowerCase())) {
    return null;
  }

  if (value.startsWith("id:")) {
    return { accountId: value.slice(3).trim() };
  }

  const users = await jiraRequest("/user/assignable/search", {
    query: {
      project: projectKey,
      query: value
    }
  });

  if (!Array.isArray(users) || users.length === 0) {
    throw new Error(`Nao encontrei responsavel para "${value}".`);
  }

  const exactMatch =
    users.find((user) => user.accountId === value) ||
    users.find(
      (user) =>
        user.displayName?.toLowerCase() === value.toLowerCase() ||
        user.emailAddress?.toLowerCase() === value.toLowerCase()
    );

  if (exactMatch) {
    return { accountId: exactMatch.accountId, displayName: exactMatch.displayName };
  }

  if (users.length > 1) {
    const suggestions = users
      .slice(0, 5)
      .map((user) => user.displayName)
      .filter(Boolean)
      .join(", ");

    throw new Error(
      `Encontrei mais de um responsavel para "${value}". Tente um nome mais especifico ou use id:ACCOUNT_ID. Sugestoes: ${suggestions}`
    );
  }

  return { accountId: users[0].accountId, displayName: users[0].displayName };
}

function buildIssueFields({
  summary,
  description,
  issueType,
  assigneeAccountId,
  dueDate,
  priorityName,
  includeProject = false
}) {
  const { projectKey, defaultIssueType } = getJiraConfig();
  const fields = {};

  if (includeProject) {
    fields.project = { key: projectKey };
    fields.issuetype = { name: issueType || defaultIssueType };
  }

  if (summary !== undefined) fields.summary = summary;
  if (description !== undefined) fields.description = textToAdf(description);
  if (assigneeAccountId !== undefined) {
    fields.assignee = assigneeAccountId ? { accountId: assigneeAccountId } : null;
  }
  if (dueDate !== undefined) fields.duedate = dueDate || null;
  if (priorityName !== undefined) {
    fields.priority = priorityName ? { name: priorityName } : null;
  }

  return fields;
}

export async function createIssue(input) {
  if (!input.summary?.trim()) {
    throw new Error("O titulo da tarefa e obrigatorio.");
  }

  const assignee = await resolveAssignee(input.assignee, input.discordUserId);
  const dueDate = normalizeDueDate(input.dueDate);
  const fields = buildIssueFields({
    summary: input.summary.trim(),
    description: input.description?.trim(),
    issueType: input.issueType?.trim(),
    assigneeAccountId: assignee?.accountId,
    dueDate,
    priorityName: input.priority?.trim(),
    includeProject: true
  });

  const created = await jiraRequest("/issue", {
    method: "POST",
    body: { fields }
  });

  const issue = await getIssue(created.key);
  return { issue, assigneeName: issue.fields.assignee?.displayName || assignee?.displayName };
}

export async function getIssue(issueKey) {
  if (!issueKey?.trim()) {
    throw new Error("A chave da issue e obrigatoria.");
  }

  return jiraRequest(`/issue/${encodeURIComponent(issueKey.trim())}`, {
    query: {
      fields:
        "summary,description,assignee,duedate,status,issuetype,project,priority,reporter,creator,created,updated,labels"
    }
  });
}

export async function listProjectIssues() {
  const { projectKey } = getJiraConfig();

  const result = await jiraRequest("/search/jql", {
    method: "POST",
    body: {
      jql: `project = ${projectKey} ORDER BY created DESC`,
      maxResults: 100,
      fields: ["summary", "status", "assignee", "duedate"]
    }
  });

  return result.issues || [];
}

export async function updateIssue(issueKey, input) {
  const assignee =
    input.assignee !== undefined || input.discordUserId !== undefined
      ? await resolveAssignee(input.assignee, input.discordUserId)
      : undefined;
  const dueDate =
    input.dueDate !== undefined ? normalizeDueDate(input.dueDate) || null : undefined;
  const fields = buildIssueFields({
    summary: input.summary?.trim(),
    description: input.description?.trim(),
    assigneeAccountId:
      input.assignee !== undefined || input.discordUserId !== undefined
        ? assignee?.accountId || null
        : undefined,
    dueDate,
    priorityName:
      input.priority !== undefined ? input.priority?.trim() || null : undefined
  });

  if (Object.keys(fields).length === 0) {
    throw new Error("Informe ao menos um campo para atualizar.");
  }

  await jiraRequest(`/issue/${encodeURIComponent(issueKey.trim())}`, {
    method: "PUT",
    body: { fields }
  });

  const issue = await getIssue(issueKey);
  return { issue, assigneeName: issue.fields.assignee?.displayName || assignee?.displayName };
}

export async function deleteIssue(issueKey) {
  if (!issueKey?.trim()) {
    throw new Error("A chave da issue e obrigatoria.");
  }

  await jiraRequest(`/issue/${encodeURIComponent(issueKey.trim())}`, {
    method: "DELETE"
  });
}

export function formatIssue(issue) {
  const summary = issue.fields?.summary || "Sem resumo";
  const project = issue.fields?.project?.key || "Sem projeto";
  const issueType = issue.fields?.issuetype?.name || "Sem tipo";
  const status = issue.fields?.status?.name || "Sem status";
  const priority = issue.fields?.priority?.name || "Sem prioridade";
  const assignee = issue.fields?.assignee?.displayName || "Nao definido";
  const reporter = issue.fields?.reporter?.displayName || "Nao definido";
  const creator = issue.fields?.creator?.displayName || "Nao definido";
  const dueDate = issue.fields?.duedate || "Sem data limite";
  const created = issue.fields?.created || "Sem data de criacao";
  const updated = issue.fields?.updated || "Sem data de atualizacao";
  const labels = issue.fields?.labels?.length ? issue.fields.labels.join(", ") : "Sem labels";
  const description =
    truncate(adfToText(issue.fields?.description).trim(), 500) || "Sem descricao";

  return [
    `Chave: ${issue.key}`,
    `Projeto: ${project}`,
    `Titulo: ${summary}`,
    `Tipo: ${issueType}`,
    `Status: ${status}`,
    `Prioridade: ${priority}`,
    `Responsavel: ${assignee}`,
    `Reporter: ${reporter}`,
    `Criador: ${creator}`,
    `Data limite: ${dueDate}`,
    `Criado em: ${created}`,
    `Atualizado em: ${updated}`,
    `Labels: ${labels}`,
    `Descricao: ${description}`
  ].join("\n");
}

export function formatIssueGroups(issues) {
  if (!issues.length) {
    return "Nenhuma tarefa encontrada no projeto.";
  }

  const groups = new Map();

  for (const issue of issues) {
    const status = issue.fields?.status?.name || "Sem status";

    if (!groups.has(status)) {
      groups.set(status, []);
    }

    const assignee = issue.fields?.assignee?.displayName || "Sem responsavel";
    const dueDate = issue.fields?.duedate ? ` | vence ${issue.fields.duedate}` : "";

    groups.get(status).push(`- ${issue.key}: ${issue.fields?.summary || "Sem resumo"} | ${assignee}${dueDate}`);
  }

  return Array.from(groups.entries())
    .map(([status, items]) => [`${status.toUpperCase()}`, ...items].join("\n"))
    .join("\n\n");
}
