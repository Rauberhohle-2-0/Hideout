import type {
  Api,
  AiProviderInfo,
  AssistantAddRequest,
  AssistantParametersWire,
  AssistantSafe,
  McpAddServerRequest,
  McpServerSafe,
} from "../shared/api.ts";

declare global {
  interface Window {
    api: Api;
  }
}

const REFRESH_INTERVAL_MS = 15_000;
const CONTENT_ID = "content";
const REFRESH_BTN_ID = "refresh-btn";
const REFRESH_ICON_ID = "refresh-icon";
const LAST_CHECK_ID = "last-check";

const MCP_CONTENT_ID = "mcp-content";
const MCP_REFRESH_BTN_ID = "mcp-refresh-btn";
const MCP_REFRESH_ICON_ID = "mcp-refresh-icon";
const MCP_LAST_CHECK_ID = "mcp-last-check";
const MCP_ADD_BTN_ID = "mcp-add-btn";
const MCP_DIALOG_ID = "mcp-dialog";
const MCP_DIALOG_CLOSE_ID = "mcp-dialog-close";
const MCP_CANCEL_BTN_ID = "mcp-cancel-btn";
const MCP_FORM_ID = "mcp-form";
const MCP_FORM_ERROR_ID = "mcp-form-error";

const ASSISTANT_CONTENT_ID = "assistant-content";
const ASSISTANT_REFRESH_BTN_ID = "assistant-refresh-btn";
const ASSISTANT_REFRESH_ICON_ID = "assistant-refresh-icon";
const ASSISTANT_LAST_CHECK_ID = "assistant-last-check";
const ASSISTANT_ADD_BTN_ID = "assistant-add-btn";
const ASSISTANT_DIALOG_ID = "assistant-dialog";
const ASSISTANT_DIALOG_CLOSE_ID = "assistant-dialog-close";
const ASSISTANT_CANCEL_BTN_ID = "assistant-cancel-btn";
const ASSISTANT_FORM_ID = "assistant-form";
const ASSISTANT_FORM_ERROR_ID = "assistant-form-error";

// Edit mode state — null = adding, string = editing that id
let editingMcpId: string | null = null;
let openMcpEdit: ((server: McpServerSafe) => void) | null = null;
let editingAssistantId: string | null = null;
let openAssistantEdit: ((assistant: AssistantSafe) => void) | null = null;

function envToText(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function headersToText(headers?: Record<string, string>): string {
  if (!headers || Object.keys(headers).length === 0) return "";
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/**
 * Plain-text summary of a not-yet-added MCP server, shown in the confirm step.
 * Env/header values are masked — the form already shows them, and echoing
 * secrets into the summary would only widen their exposure in the DOM.
 */
function buildMcpSummary(payload: McpAddServerRequest): string {
  const lines: string[] = [];
  lines.push(`ID: ${payload.id}`);
  lines.push(`Name: ${payload.name}`);
  lines.push(`Transport: ${payload.transport}`);
  if (payload.description) lines.push(`Description: ${payload.description}`);
  if (payload.stdio) {
    const { command, args, cwd, env } = payload.stdio;
    lines.push(`Command: ${[command, ...(args ?? [])].join(" ")}`);
    if (cwd) lines.push(`Working directory: ${cwd}`);
    if (env && Object.keys(env).length > 0) {
      lines.push("Environment (values hidden):");
      for (const k of Object.keys(env)) lines.push(`  ${k}=••••`);
    }
  }
  const h = payload.http ?? payload.sse;
  if (h) {
    lines.push(`URL: ${h.url}`);
    if (h.timeoutSeconds !== undefined) lines.push(`Timeout: ${h.timeoutSeconds}s`);
    if (h.headers && Object.keys(h.headers).length > 0) {
      lines.push("Headers (values hidden):");
      for (const k of Object.keys(h.headers)) lines.push(`  ${k}: ••••`);
    }
  }
  return lines.join("\n");
}

// ---- tiny DOM helpers ------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeSchema(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "";
  const s = schema as { properties?: Record<string, object>; required?: string[] };
  if (!s.properties) return "";
  const keys = Object.keys(s.properties);
  if (keys.length === 0) return "";
  const required = new Set(s.required ?? []);
  return keys.map((k) => (required.has(k) ? k : `${k}?`)).join(", ");
}

function friendlyKind(kind: AiProviderInfo["kind"]): string {
  return kind === "local" ? "Local" : "Cloud";
}

function friendlyTransport(t: string): string {
  return t;
}

// ---- provider card ---------------------------------------------------------

interface HealthResult {
  ok: boolean;
  latencyMs?: number;
  version?: string;
  error?: string;
}

interface ProviderCard {
  provider: AiProviderInfo;
  element: HTMLElement;
  refresh(): Promise<void>;
  refreshHealth(): Promise<void>;
  setBusy(busy: boolean): void;
}

function createProviderCard(provider: AiProviderInfo): ProviderCard {
  let health: HealthResult | null = null;
  let models: Array<{ id: string; name: string }> | null = null;
  let busy = false;

  const card = el("section", "provider-card");
  card.dataset.provider = provider.id;

  // Header
  const header = el("div", "provider-header");
  const title = el("div", "provider-title");
  title.append(el("span", "provider-name", provider.displayName));
  title.append(
    el("span", `provider-kind provider-kind-${provider.kind}`, friendlyKind(provider.kind)),
  );
  header.append(title);

  const baseUrl = provider.config?.baseUrl;
  if (baseUrl) header.append(el("div", "provider-url", baseUrl));
  card.append(header);

  if (provider.config?.defaultModel) {
    card.append(el("div", "provider-default-model", `Default model: ${provider.config.defaultModel}`));
  }

  // Status row
  const statusRow = el("div", "provider-status");
  const dot = el("span", "status-dot status-unknown");
  const statusText = el("span", "status-text", "Waiting…");
  statusRow.append(dot, statusText);
  card.append(statusRow);

  const latency = el("div", "provider-latency");
  card.append(latency);

  const errorBox = el("div", "provider-error");
  errorBox.hidden = true;
  card.append(errorBox);

  // Models
  const modelsSection = el("div", "models-section");
  const modelsTitle = el("h2", "models-title", "Models");
  const modelsList = el("ul", "models-list");
  modelsSection.append(modelsTitle, modelsList);
  card.append(modelsSection);

  function render(): void {
    // Status
    if (busy) {
      dot.className = "status-dot status-checking";
      statusText.className = "status-text";
      statusText.textContent = "Checking…";
    } else if (!health) {
      dot.className = "status-dot status-unknown";
      statusText.className = "status-text";
      statusText.textContent = "Not checked yet";
    } else if (health.ok) {
      dot.className = "status-dot status-ok";
      statusText.className = "status-text status-ok-c";
      statusText.textContent = health.version
        ? `Connected · Ollama v${health.version}`
        : "Connected";
    } else {
      dot.className = "status-dot status-error";
      statusText.className = "status-text status-err";
      statusText.textContent = "Connection failed";
    }

    // Latency
    if (!busy && health && health.ok && health.latencyMs !== undefined) {
      latency.textContent = `Latency: ${health.latencyMs} ms`;
    } else if (!busy && health && !health.ok) {
      latency.textContent = "";
    } else {
      latency.textContent = "";
    }

    // Error body
    if (!busy && health && !health.ok && health.error) {
      errorBox.textContent = health.error;
      errorBox.hidden = false;
    } else {
      errorBox.textContent = "";
      errorBox.hidden = true;
    }

    // Models
    modelsList.replaceChildren();
    if (!health || !health.ok || models === null) {
      modelsTitle.textContent = "Models";
    } else if (models.length === 0) {
      modelsTitle.textContent = "Models";
      modelsList.append(el("li", "models-empty", "No models installed yet."));
    } else {
      modelsTitle.textContent = `Models (${models.length})`;
      for (const m of models) {
        const li = el("li", "model-item");
        li.append(el("span", "model-name", m.name));
        if (m.id !== m.name) li.append(el("span", "model-id", m.id));
        modelsList.append(li);
      }
    }
  }

  /** Health only — what the periodic timer runs, so it never re-lists models. */
  async function refreshHealth(): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      try {
        health = await window.api.aiHealth(provider.id);
        if (!health.ok) models = null;
      } catch (e) {
        health = { ok: false, error: errorText(e) };
        models = null;
      }
    } finally {
      busy = false;
      render();
    }
  }

  /** Full refresh — health, plus models when healthy. Runs on an explicit check. */
  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      try {
        health = await window.api.aiHealth(provider.id);
      } catch (e) {
        health = { ok: false, error: errorText(e) };
        models = null;
        return;
      }
      if (health.ok) {
        try {
          const raw = await window.api.aiListModels(provider.id);
          models = raw.map((m) => ({ id: m.id, name: m.name }));
        } catch (e) {
          // Health passed but listing failed — keep health green, models empty
          models = [];
          health = { ...health, error: `Models unavailable: ${errorText(e)}` };
        }
      } else {
        models = null;
      }
    } finally {
      busy = false;
      render();
    }
  }

  render();
  return { provider, element: card, refresh, refreshHealth, setBusy: (b: boolean) => void (busy = b) };
}

// ---- MCP card --------------------------------------------------------------

interface McpHealthResult {
  ok: boolean;
  latencyMs?: number;
  version?: string;
  error?: string;
}

interface McpCard {
  server: McpServerSafe;
  element: HTMLElement;
  refresh(): Promise<void>;
  refreshHealth(): Promise<void>;
}

function createMcpCard(server: McpServerSafe, onChanged: () => Promise<void>): McpCard {
  let health: McpHealthResult | null = null;
  let tools: Array<{ name: string; description?: string; inputSchema?: unknown }> | null = null;
  let busy = false;

  const card = el("section", "provider-card mcp-card");
  card.dataset.mcp = server.id;
  if (server.enabled === false) card.classList.add("mcp-disabled");

  // Header
  const header = el("div", "provider-header");
  const title = el("div", "provider-title");
  title.append(el("span", "provider-name", server.name));
  title.append(el("span", `transport-badge transport-badge-${server.transport}`, friendlyTransport(server.transport)));
  if (server.enabled === false) {
    title.append(el("span", "provider-kind provider-kind-cloud", "Disabled"));
  }
  header.append(title);
  // show id subtly
  header.append(el("div", "provider-url", `id: ${server.id}`));
  card.append(header);

  if (server.description) {
    card.append(el("div", "mcp-meta", server.description));
  }

  // Transport details
  const detailLine = el("div", "provider-url");
  if (server.transport === "stdio" && server.stdio) {
    const args = server.stdio.args?.join(" ") ?? "";
    detailLine.textContent = `${server.stdio.command} ${args}`.trim();
    if (server.stdio.cwd) detailLine.textContent += ` · cwd: ${server.stdio.cwd}`;
  } else if (server.http) {
    detailLine.textContent = server.http.url;
  }
  if (detailLine.textContent) card.append(detailLine);

  // Status row (same visual language as Ollama)
  const statusRow = el("div", "provider-status");
  const dot = el("span", "status-dot status-unknown");
  const statusText = el("span", "status-text", "Waiting…");
  statusRow.append(dot, statusText);
  card.append(statusRow);

  const latency = el("div", "provider-latency");
  card.append(latency);

  const errorBox = el("div", "provider-error");
  errorBox.hidden = true;
  card.append(errorBox);

  // Tools section — analogous to Models
  const toolsSection = el("div", "models-section");
  const toolsTitle = el("h2", "models-title", "Tools");
  const toolsList = el("ul", "models-list");
  toolsSection.append(toolsTitle, toolsList);
  card.append(toolsSection);

  // Actions
  const actions = el("div", "mcp-actions");
  const editBtn = el("button", "btn") as HTMLButtonElement;
  editBtn.type = "button";
  editBtn.textContent = "Edit";
  editBtn.title = "Edit this MCP server";
  const connectBtn = el("button", "btn btn-primary") as HTMLButtonElement;
  connectBtn.type = "button";
  connectBtn.textContent = "Check";
  const toggleBtn = el("button", "btn") as HTMLButtonElement;
  toggleBtn.type = "button";
  toggleBtn.textContent = server.enabled === false ? "Enable" : "Disable";
  toggleBtn.title = server.enabled === false ? "Enable this server" : "Disable this server";
  if (server.enabled === false) toggleBtn.classList.add("btn-primary");
  const removeBtn = el("button", "btn") as HTMLButtonElement;
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  actions.append(editBtn, connectBtn, toggleBtn, removeBtn);
  card.append(actions);

  function render(): void {
    const isDisabled = server.enabled === false;
    if (busy) {
      dot.className = "status-dot status-checking";
      statusText.className = "status-text";
      statusText.textContent = "Checking…";
      editBtn.disabled = true;
      connectBtn.disabled = true;
      toggleBtn.disabled = true;
      removeBtn.disabled = true;
    } else if (isDisabled) {
      dot.className = "status-dot status-unknown";
      statusText.className = "status-text";
      statusText.textContent = "Disabled";
      editBtn.disabled = false;
      connectBtn.disabled = true;
      toggleBtn.disabled = false;
      removeBtn.disabled = false;
    } else if (!health) {
      dot.className = "status-dot status-unknown";
      statusText.className = "status-text";
      statusText.textContent = "Not checked yet";
      editBtn.disabled = false;
      connectBtn.disabled = false;
      toggleBtn.disabled = false;
      removeBtn.disabled = false;
    } else if (health.ok) {
      dot.className = "status-dot status-ok";
      statusText.className = "status-text status-ok-c";
      statusText.textContent = health.version ? `Connected · v${health.version}` : "Connected";
      editBtn.disabled = false;
      connectBtn.disabled = false;
      toggleBtn.disabled = false;
      removeBtn.disabled = false;
    } else {
      dot.className = "status-dot status-error";
      statusText.className = "status-text status-err";
      statusText.textContent = "Connection failed";
      editBtn.disabled = false;
      connectBtn.disabled = false;
      toggleBtn.disabled = false;
      removeBtn.disabled = false;
    }

    if (!busy && health && health.ok && health.latencyMs !== undefined) {
      latency.textContent = `Latency: ${health.latencyMs} ms`;
    } else {
      latency.textContent = "";
    }

    if (!busy && health && !health.ok && health.error) {
      errorBox.textContent = health.error;
      errorBox.hidden = false;
    } else {
      errorBox.textContent = "";
      errorBox.hidden = true;
    }

    // Tools
    toolsList.replaceChildren();
    if (!health || !health.ok || tools === null) {
      toolsTitle.textContent = "Tools";
      if (health && !health.ok) {
        // hide empty message when failed — error box shows reason
      } else if (health && health.ok && tools !== null && tools.length === 0) {
        // will be handled below
      }
    }
    if (!health || !health.ok) {
      toolsTitle.textContent = "Tools";
    } else if (tools !== null && tools.length === 0) {
      toolsTitle.textContent = "Tools";
      toolsList.append(el("li", "models-empty", "No tools exposed."));
    } else if (tools && tools.length > 0) {
      toolsTitle.textContent = `Tools (${tools.length})`;
      for (const t of tools) {
        const li = el("li", "model-item tool-item");
        const head = el("div", "tool-head");
        head.append(el("span", "model-name", t.name));
        if (t.description) head.append(el("span", "model-id", t.description));
        li.append(head);

        const runBox = el("details", "tool-run");
        const summary = el("summary", "tool-run-summary", "Run");
        const argsLabel = el("label", "tool-arg-label", "Arguments (JSON)");
        const argsText = el("textarea", "tool-args") as HTMLTextAreaElement;
        argsText.rows = 3;
        argsText.placeholder = '{}' + ' — e.g. {"query":"..."}';
        const hintText = describeSchema(t.inputSchema);
        const hint = el("div", "tool-hint", hintText ? `Params: ${hintText}` : "No required parameters.");
        const go = el("button", "btn btn-primary btn-sm") as HTMLButtonElement;
        go.type = "button";
        go.textContent = "Execute";
        const resultBox = el("pre", "tool-result");
        resultBox.hidden = true;
        runBox.append(summary, argsLabel, argsText, hint, go, resultBox);
        li.append(runBox);

        go.addEventListener("click", async () => {
          let args: Record<string, unknown> | undefined;
          const raw = argsText.value.trim();
          if (raw) {
            try {
              args = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              resultBox.classList.add("tool-result-error");
              resultBox.textContent = "Invalid JSON arguments.";
              resultBox.hidden = false;
              return;
            }
          }
          go.disabled = true;
          go.textContent = "Running…";
          try {
            const res = await window.api.mcpCallTool(server.id, t.name, args);
            resultBox.classList.remove("tool-result-error");
            let payload: string;
            if (res.text) payload = res.text;
            else if (res.structuredContent !== undefined) payload = JSON.stringify(res.structuredContent, null, 2);
            else if (res.content !== undefined) payload = JSON.stringify(res.content, null, 2);
            else payload = "(empty result)";
            resultBox.textContent = res.isError ? `Tool errored:\n${payload}` : payload;
          } catch (e) {
            resultBox.classList.add("tool-result-error");
            resultBox.textContent = `Call failed: ${errorText(e)}`;
          } finally {
            resultBox.hidden = false;
            go.disabled = false;
            go.textContent = "Execute";
          }
        });
        toolsList.append(li);
      }
    } else {
      toolsTitle.textContent = "Tools";
    }
  }

  /** Health only — what the periodic timer runs, so it never re-lists tools. */
  async function refreshHealth(): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      try {
        health = await window.api.mcpHealth(server.id);
        if (!health.ok) tools = null;
      } catch (e) {
        health = { ok: false, error: errorText(e) };
        tools = null;
      }
    } finally {
      busy = false;
      render();
    }
  }

  /** Full refresh — health, plus tools when healthy. Explicit "Check" or after edits. */
  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      try {
        health = await window.api.mcpHealth(server.id);
      } catch (e) {
        health = { ok: false, error: errorText(e) };
        tools = null;
        return;
      }
      if (health.ok) {
        try {
          const raw = await window.api.mcpListTools(server.id);
          tools = raw.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        } catch (e) {
          // Tools listing failed but health is fine — keep the list empty rather
          // than turning a healthy status red.
          tools = [];
        }
      } else {
        tools = null;
      }
    } finally {
      busy = false;
      render();
    }
  }

  connectBtn.addEventListener("click", () => void refresh());
  toggleBtn.addEventListener("click", async () => {
    const nextEnabled = server.enabled === false ? true : false;
    toggleBtn.disabled = true;
    try {
      await window.api.mcpSetEnabled(server.id, nextEnabled);
      await onChanged();
    } catch (e) {
      alert(`Failed to ${nextEnabled ? "enable" : "disable"}: ${errorText(e)}`);
      toggleBtn.disabled = false;
    }
  });
  removeBtn.addEventListener("click", async () => {
    if (!confirm(`Remove MCP server "${server.name}" (${server.id})? This cannot be undone.`)) return;
    removeBtn.disabled = true;
    try {
      await window.api.mcpRemoveServer(server.id);
      await onChanged();
    } catch (e) {
      alert(`Failed to remove: ${errorText(e)}`);
      removeBtn.disabled = false;
    }
  });
  editBtn.addEventListener("click", () => {
    if (openMcpEdit) openMcpEdit(server);
  });

  render();
  return { server, element: card, refresh, refreshHealth };
}

// ---- assistant card ----------------------------------------------------------

interface AssistantCard {
  assistant: AssistantSafe;
  element: HTMLElement;
}

function friendlyParamLabel(k: string, v: unknown): string {
  return `${k}=${String(v)}`;
}

function createAssistantCard(assistant: AssistantSafe, onChanged: () => Promise<void>): AssistantCard {
  const card = el("section", "provider-card assistant-card");
  card.dataset.assistant = assistant.id;
  if (assistant.enabled === false) card.classList.add("assistant-disabled");

  // Header
  const header = el("div", "provider-header");
  const title = el("div", "provider-title");
  if (assistant.emoji) title.append(el("span", "assistant-emoji", assistant.emoji));
  title.append(el("span", "provider-name", assistant.name));
  if (assistant.enabled === false) {
    title.append(el("span", "provider-kind provider-kind-cloud", "Disabled"));
  } else {
    title.append(el("span", "provider-kind provider-kind-local", "Active"));
  }
  header.append(title);
  header.append(el("div", "provider-url", `id: ${assistant.id}`));
  card.append(header);

  if (assistant.description) {
    card.append(el("div", "mcp-meta", assistant.description));
  }

  // Adherence line
  if (assistant.providerId || assistant.model) {
    const adherence = el("div", "provider-url");
    const parts: string[] = [];
    if (assistant.providerId) parts.push(`provider: ${assistant.providerId}`);
    if (assistant.model) parts.push(`model: ${assistant.model}`);
    adherence.textContent = parts.join(" · ");
    card.append(adherence);
  }

  // Instructions preview
  const instr = el("div", "assistant-instructions");
  instr.textContent = assistant.instructions;
  instr.title = assistant.instructions;
  card.append(instr);

  // Parameters chips
  if (assistant.parameters && Object.keys(assistant.parameters).length > 0) {
    const chips = el("div", "assistant-params");
    for (const [k, v] of Object.entries(assistant.parameters)) {
      if (v === undefined) continue;
      const text = Array.isArray(v) ? `${k}=${v.join(",")}` : friendlyParamLabel(k, v);
      chips.append(el("span", "param-chip", text));
    }
    if (chips.childNodes.length > 0) card.append(chips);
  }

  // Timestamps
  if (assistant.updatedAt || assistant.createdAt) {
    const meta = el("div", "provider-url");
    const ts = assistant.updatedAt ?? assistant.createdAt;
    if (ts) {
      try {
        const d = new Date(ts);
        meta.textContent = `Updated: ${d.toLocaleString()}`;
      } catch {
        meta.textContent = `Updated: ${ts}`;
      }
      card.append(meta);
    }
  }

  // Actions
  const actions = el("div", "assistant-actions");
  const editBtn = el("button", "btn") as HTMLButtonElement;
  editBtn.type = "button";
  editBtn.textContent = "Edit";
  editBtn.title = "Edit this assistant";
  const toggleBtn = el("button", "btn") as HTMLButtonElement;
  toggleBtn.type = "button";
  toggleBtn.textContent = assistant.enabled === false ? "Enable" : "Disable";
  toggleBtn.title = assistant.enabled === false ? "Enable this assistant" : "Disable this assistant";
  if (assistant.enabled === false) toggleBtn.classList.add("btn-primary");
  const removeBtn = el("button", "btn") as HTMLButtonElement;
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  actions.append(editBtn, toggleBtn, removeBtn);
  card.append(actions);

  toggleBtn.addEventListener("click", async () => {
    const nextEnabled = assistant.enabled === false ? true : false;
    toggleBtn.disabled = true;
    try {
      await window.api.assistantSetEnabled(assistant.id, nextEnabled);
      await onChanged();
    } catch (e) {
      alert(`Failed to ${nextEnabled ? "enable" : "disable"}: ${errorText(e)}`);
      toggleBtn.disabled = false;
    }
  });
  removeBtn.addEventListener("click", async () => {
    if (!confirm(`Remove assistant "${assistant.name}" (${assistant.id})? This cannot be undone.`)) return;
    removeBtn.disabled = true;
    try {
      await window.api.assistantRemove(assistant.id);
      await onChanged();
    } catch (e) {
      alert(`Failed to remove: ${errorText(e)}`);
      removeBtn.disabled = false;
    }
  });
  editBtn.addEventListener("click", () => {
    if (openAssistantEdit) openAssistantEdit(assistant);
  });

  return { assistant, element: card };
}

// ---- page level ------------------------------------------------------------

let cards: ProviderCard[] = [];
let lastCheck = 0;

let mcpCards: McpCard[] = [];
let mcpLastCheck = 0;

let assistantCards: AssistantCard[] = [];
let assistantLastCheck = 0;

function setLoading(loading: boolean, text: string): void {
  const icon = document.getElementById(REFRESH_ICON_ID);
  const btn = document.getElementById(REFRESH_BTN_ID) as HTMLButtonElement | null;
  if (icon) icon.style.display = loading ? "" : "none";
  if (btn) btn.disabled = loading;
  void text; // keep for potential future use
}

function setMcpLoading(loading: boolean): void {
  const icon = document.getElementById(MCP_REFRESH_ICON_ID);
  const btn = document.getElementById(MCP_REFRESH_BTN_ID) as HTMLButtonElement | null;
  if (icon) icon.style.display = loading ? "" : "none";
  if (btn) btn.disabled = loading;
}

function updateLastCheck(): void {
  const node = document.getElementById(LAST_CHECK_ID);
  if (!node || lastCheck === 0) return;
  const dt = new Date(lastCheck);
  const t = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const ago = Math.max(0, Math.round((Date.now() - lastCheck) / 1000));
  node.textContent = `Last checked at ${t} · ${ago}s ago`;
}

function updateMcpLastCheck(): void {
  const node = document.getElementById(MCP_LAST_CHECK_ID);
  if (!node || mcpLastCheck === 0) return;
  const dt = new Date(mcpLastCheck);
  const t = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const ago = Math.max(0, Math.round((Date.now() - mcpLastCheck) / 1000));
  node.textContent = `Last checked at ${t} · ${ago}s ago`;
}

function setAssistantLoading(loading: boolean): void {
  const icon = document.getElementById(ASSISTANT_REFRESH_ICON_ID);
  const btn = document.getElementById(ASSISTANT_REFRESH_BTN_ID) as HTMLButtonElement | null;
  if (icon) icon.style.display = loading ? "" : "none";
  if (btn) btn.disabled = loading;
}

function updateAssistantLastCheck(): void {
  const node = document.getElementById(ASSISTANT_LAST_CHECK_ID);
  if (!node || assistantLastCheck === 0) return;
  const dt = new Date(assistantLastCheck);
  const t = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const ago = Math.max(0, Math.round((Date.now() - assistantLastCheck) / 1000));
  node.textContent = `Last checked at ${t} · ${ago}s ago`;
}

function renderContent(): void {
  const content = document.getElementById(CONTENT_ID);
  content?.replaceChildren();
  for (const c of cards) content?.append(c.element);
}

function renderMcpContent(): void {
  const content = document.getElementById(MCP_CONTENT_ID);
  if (!content) return;
  content.replaceChildren();
  if (mcpCards.length === 0) {
    const empty = el("div", "mcp-empty", "No MCP servers configured. Add one to connect tools.");
    content.append(empty);
    return;
  }
  for (const c of mcpCards) content.append(c.element);
}

function renderAssistantContent(): void {
  const content = document.getElementById(ASSISTANT_CONTENT_ID);
  if (!content) return;
  content.replaceChildren();
  if (assistantCards.length === 0) {
    const empty = el("div", "assistant-empty", "No assistants yet. Create one to customize system prompts & sampling.");
    content.append(empty);
    return;
  }
  for (const c of assistantCards) content.append(c.element);
}

async function refreshAll(showSpinner: boolean): Promise<void> {
  if (cards.length === 0) return;
  if (showSpinner) setLoading(true, "");
  try {
    await Promise.all(cards.map((c) => c.refresh()));
  } finally {
    if (showSpinner) setLoading(false, "");
    lastCheck = Date.now();
    updateLastCheck();
  }
}

/** Periodic pass: refresh health only, leaving already-loaded models in place. */
async function refreshAllHealth(): Promise<void> {
  if (cards.length === 0) return;
  await Promise.all(cards.map((c) => c.refreshHealth()));
  lastCheck = Date.now();
  updateLastCheck();
}

async function refreshAllMcp(showSpinner: boolean): Promise<void> {
  if (mcpCards.length === 0) {
    mcpLastCheck = Date.now();
    updateMcpLastCheck();
    return;
  }
  if (showSpinner) setMcpLoading(true);
  try {
    await Promise.all(mcpCards.map((c) => c.refresh()));
  } finally {
    if (showSpinner) setMcpLoading(false);
    mcpLastCheck = Date.now();
    updateMcpLastCheck();
  }
}

/** Periodic pass: refresh health only, leaving already-loaded tools in place. */
async function refreshAllMcpHealth(): Promise<void> {
  if (mcpCards.length === 0) {
    mcpLastCheck = Date.now();
    updateMcpLastCheck();
    return;
  }
  await Promise.all(mcpCards.map((c) => c.refreshHealth()));
  mcpLastCheck = Date.now();
  updateMcpLastCheck();
}

async function loadMcpServers(): Promise<void> {
  const content = document.getElementById(MCP_CONTENT_ID);
  if (!content) return;
  if (!window.api?.mcpListServers) {
    content.replaceChildren(el("p", "load-error", "MCP API unavailable — please relaunch the app."));
    return;
  }
  try {
    const servers = await window.api.mcpListServers();
    mcpCards = servers.map((s) => createMcpCard(s, async () => {
      await loadMcpServers();
      await refreshAllMcp(true);
    }));
    renderMcpContent();
  } catch (e) {
    content.replaceChildren(el("p", "load-error", `Failed to load MCP servers: ${errorText(e)}`));
    return;
  }
  await refreshAllMcp(true);
}

async function loadAssistants(): Promise<void> {
  const content = document.getElementById(ASSISTANT_CONTENT_ID);
  if (!content) return;
  if (!window.api?.assistantList) {
    content.replaceChildren(el("p", "load-error", "Assistant API unavailable — please relaunch the app."));
    return;
  }
  if (assistantLastCheck === 0) setAssistantLoading(true);
  try {
    const assistants = await window.api.assistantList();
    assistantCards = assistants.map((a) => createAssistantCard(a, async () => {
      await loadAssistants();
    }));
    renderAssistantContent();
  } catch (e) {
    content.replaceChildren(el("p", "load-error", `Failed to load assistants: ${errorText(e)}`));
    return;
  } finally {
    setAssistantLoading(false);
    assistantLastCheck = Date.now();
    updateAssistantLastCheck();
  }
}

async function refreshAssistants(showSpinner: boolean): Promise<void> {
  if (showSpinner) setAssistantLoading(true);
  try {
    await loadAssistants();
  } finally {
    if (showSpinner) setAssistantLoading(false);
    assistantLastCheck = Date.now();
    updateAssistantLastCheck();
  }
}

// ---- Add MCP dialog -------------------------------------------------------

function parseArgs(input: string): string[] | undefined {
  const t = input.trim();
  if (!t) return undefined;
  // split by comma or whitespace respecting quoted? keep simple: split by comma then whitespace
  // If comma present, split by comma; otherwise split by whitespace
  if (t.includes(",")) {
    return t.split(",").map((s) => s.trim()).filter(Boolean);
  }
  // whitespace split, but preserve quoted? simple whitespace split
  return t.split(/\s+/).filter(Boolean);
}

function parseEnv(input: string): Record<string, string> | undefined {
  const t = input.trim();
  if (!t) return undefined;
  const out: Record<string, string> = {};
  for (const line of t.split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const k = raw.slice(0, eq).trim();
    const v = raw.slice(eq + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseHeaders(input: string): Record<string, string> | undefined {
  const t = input.trim();
  if (!t) return undefined;
  const out: Record<string, string> = {};
  for (const line of t.split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    const k = raw.slice(0, colon).trim();
    const v = raw.slice(colon + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function setupMcpDialog(): void {
  const dialog = document.getElementById(MCP_DIALOG_ID) as HTMLDialogElement | null;
  const addBtn = document.getElementById(MCP_ADD_BTN_ID) as HTMLButtonElement | null;
  const closeBtn = document.getElementById(MCP_DIALOG_CLOSE_ID) as HTMLButtonElement | null;
  const cancelBtn = document.getElementById(MCP_CANCEL_BTN_ID) as HTMLButtonElement | null;
  const form = document.getElementById(MCP_FORM_ID) as HTMLFormElement | null;
  const errBox = document.getElementById(MCP_FORM_ERROR_ID);
  const transportEl = document.getElementById("mcp-transport") as HTMLSelectElement | null;
  const stdioFields = document.getElementById("mcp-fields-stdio");
  const httpFields = document.getElementById("mcp-fields-http");
  const dialogTitle = document.getElementById("mcp-dialog-title");
  const submitBtn = document.getElementById("mcp-submit-btn") as HTMLButtonElement | null;
  const idInput = document.getElementById("mcp-id") as HTMLInputElement | null;
  if (!dialog || !addBtn || !form || !transportEl || !stdioFields || !httpFields) return;

  function updateTransportFields(): void {
    const v = transportEl!.value;
    if (v === "stdio") {
      stdioFields!.classList.remove("hidden");
      httpFields!.classList.add("hidden");
    } else {
      stdioFields!.classList.add("hidden");
      httpFields!.classList.remove("hidden");
    }
  }
  transportEl.addEventListener("change", updateTransportFields);
  updateTransportFields();

  // ---- confirmation step -------------------------------------------------
  // New servers are not persisted on submit: the user first reviews a summary
  // of exactly what will be spawned / connected to, then confirms explicitly.
  const confirmBox = el("div", "mcp-confirm");
  confirmBox.hidden = true;
  const confirmHeading = el("h3", "mcp-confirm-title", "Review this MCP server");
  const confirmWarn = el("div", "mcp-confirm-warn");
  const confirmSummary = el("pre", "mcp-confirm-summary");
  const confirmError = el("div", "form-error");
  confirmError.hidden = true;
  const confirmFoot = el("div", "dialog-foot");
  const backBtn = el("button", "btn") as HTMLButtonElement;
  backBtn.type = "button";
  backBtn.textContent = "Back to form";
  const confirmBtn = el("button", "btn btn-primary") as HTMLButtonElement;
  confirmBtn.type = "button";
  confirmBtn.textContent = "Confirm & add";
  confirmFoot.append(backBtn, confirmBtn);
  confirmBox.append(confirmHeading, confirmWarn, confirmSummary, confirmError, confirmFoot);
  dialog.append(confirmBox);

  let pendingPayload: McpAddServerRequest | null = null;

  function showConfirm(payload: McpAddServerRequest): void {
    pendingPayload = payload;
    confirmWarn.textContent =
      payload.transport === "stdio"
        ? "This will run the command above on your machine. An MCP server can execute arbitrary code and read your files — only continue if you trust this server."
        : "This will connect to the URL above and send the configured headers. Only continue if you trust this server.";
    confirmSummary.textContent = buildMcpSummary(payload);
    confirmError.textContent = "";
    confirmError.hidden = true;
    if (dialogTitle) dialogTitle.textContent = "Confirm MCP server";
    form!.hidden = true;
    confirmBox.hidden = false;
  }

  function backToForm(): void {
    pendingPayload = null;
    confirmBox.hidden = true;
    form!.hidden = false;
    confirmError.textContent = "";
    confirmError.hidden = true;
    setDialogMode(editingMcpId !== null ? "edit" : "add");
  }

  confirmBtn.addEventListener("click", async () => {
    if (!pendingPayload) return;
    confirmBtn.disabled = true;
    try {
      await window.api.mcpAddServer(pendingPayload);
      pendingPayload = null;
      close();
      await loadMcpServers();
    } catch (err) {
      confirmError.textContent = errorText(err);
      confirmError.hidden = false;
      confirmBtn.disabled = false;
    }
  });
  backBtn.addEventListener("click", backToForm);

  function setDialogMode(mode: "add" | "edit"): void {
    if (dialogTitle) dialogTitle.textContent = mode === "edit" ? "Edit MCP Server" : "Add MCP Server";
    if (submitBtn) submitBtn.textContent = mode === "edit" ? "Save changes" : "Add server";
  }

  function open(): void {
    editingMcpId = null;
    setDialogMode("add");
    if (errBox) { errBox.textContent = ""; errBox.hidden = true; }
    form!.reset();
    if (idInput) { idInput.disabled = false; idInput.removeAttribute("aria-disabled"); }
    transportEl!.disabled = false;
    // reset transport default to stdio
    transportEl!.value = "stdio";
    updateTransportFields();
    // default enabled true handled by form reset
    pendingPayload = null;
    confirmBox.hidden = true;
    form!.hidden = false;
    if (typeof dialog!.showModal === "function") dialog!.showModal();
    else (dialog as unknown as { open: boolean }).open = true;
  }

  function openForEdit(server: McpServerSafe): void {
    editingMcpId = server.id;
    setDialogMode("edit");
    pendingPayload = null;
    confirmBox.hidden = true;
    form!.hidden = false;
    if (errBox) { errBox.textContent = ""; errBox.hidden = true; }
    form!.reset();
    // Populate common fields
    const idEl = document.getElementById("mcp-id") as HTMLInputElement | null;
    const nameEl = document.getElementById("mcp-name") as HTMLInputElement | null;
    const descEl = document.getElementById("mcp-desc") as HTMLInputElement | null;
    const enabledEl = document.getElementById("mcp-enabled") as HTMLSelectElement | null;
    if (idEl) { idEl.value = server.id; idEl.disabled = true; }
    if (nameEl) nameEl.value = server.name;
    if (descEl) descEl.value = server.description ?? "";
    if (enabledEl) enabledEl.value = server.enabled ? "true" : "false";
    transportEl!.value = server.transport;
    transportEl!.disabled = true; // transport change not allowed via edit (recreate if needed)
    updateTransportFields();

    if (server.transport === "stdio") {
      const cmdEl = document.getElementById("mcp-command") as HTMLInputElement | null;
      const cwdEl = document.getElementById("mcp-cwd") as HTMLInputElement | null;
      const argsEl = document.getElementById("mcp-args") as HTMLInputElement | null;
      const envEl = document.getElementById("mcp-env") as HTMLTextAreaElement | null;
      if (cmdEl) cmdEl.value = server.stdio?.command ?? "";
      if (cwdEl) cwdEl.value = server.stdio?.cwd ?? "";
      if (argsEl) argsEl.value = server.stdio?.args?.join(" ") ?? "";
      if (envEl) envEl.value = envToText(server.stdio?.env);
      if (envEl && server.stdio?.env && Object.values(server.stdio.env).includes("***")) {
        envEl.placeholder = "Secrets shown as *** — leave as is to keep, or replace with new value";
      }
      // clear http fields
      const urlEl = document.getElementById("mcp-url") as HTMLInputElement | null;
      const headersEl = document.getElementById("mcp-headers") as HTMLTextAreaElement | null;
      const timeoutEl = document.getElementById("mcp-timeout") as HTMLInputElement | null;
      if (urlEl) urlEl.value = "";
      if (headersEl) headersEl.value = "";
      if (timeoutEl) timeoutEl.value = "";
    } else {
      const urlEl = document.getElementById("mcp-url") as HTMLInputElement | null;
      const headersEl = document.getElementById("mcp-headers") as HTMLTextAreaElement | null;
      const timeoutEl = document.getElementById("mcp-timeout") as HTMLInputElement | null;
      if (urlEl) urlEl.value = server.http?.url ?? "";
      if (headersEl) headersEl.value = headersToText(server.http?.headers);
      if (headersEl && server.http?.headers && Object.values(server.http.headers).includes("***")) {
        headersEl.placeholder = "Secrets shown as *** — leave as is to keep, or replace with new value";
      }
      if (timeoutEl) timeoutEl.value = server.http?.timeoutSeconds ? String(server.http.timeoutSeconds) : "";
      // clear stdio fields
      const cmdEl = document.getElementById("mcp-command") as HTMLInputElement | null;
      const cwdEl = document.getElementById("mcp-cwd") as HTMLInputElement | null;
      const argsEl = document.getElementById("mcp-args") as HTMLInputElement | null;
      const envEl = document.getElementById("mcp-env") as HTMLTextAreaElement | null;
      if (cmdEl) cmdEl.value = "";
      if (cwdEl) cwdEl.value = "";
      if (argsEl) argsEl.value = "";
      if (envEl) envEl.value = "";
    }

    if (typeof dialog!.showModal === "function") dialog!.showModal();
    else (dialog as unknown as { open: boolean }).open = true;
  }

  // expose for cards
  openMcpEdit = openForEdit;

  function close(): void {
    if (typeof dialog!.close === "function") {
      try { dialog!.close(); } catch { dialog!.removeAttribute("open"); }
    } else dialog!.removeAttribute("open");
    // reset edit + confirm state after close
    editingMcpId = null;
    pendingPayload = null;
    confirmBox.hidden = true;
    form!.hidden = false;
    if (idInput) idInput.disabled = false;
    transportEl!.disabled = false;
    setDialogMode("add");
  }

  addBtn.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  cancelBtn?.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target === dialog) close();
  });
  // also reset on dialog close event (Esc)
  dialog.addEventListener("close", () => {
    editingMcpId = null;
    if (idInput) idInput.disabled = false;
    transportEl!.disabled = false;
    pendingPayload = null;
    confirmBox.hidden = true;
    form!.hidden = false;
    setDialogMode("add");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errBox) { errBox.textContent = ""; errBox.hidden = true; }
    const submitBtnEl = document.getElementById("mcp-submit-btn") as HTMLButtonElement | null;
    if (submitBtnEl) submitBtnEl.disabled = true;

    const isEdit = editingMcpId !== null;
    const fd = new FormData(form);
    // id and transport may be disabled in edit mode — fallback to state / direct element
    const rawId = (fd.get("id") as string | null)?.trim() ?? "";
    const id = isEdit ? editingMcpId! : rawId;
    const name = String(fd.get("name") ?? "").trim();
    // transportEl.value is authoritative even when disabled
    const transport = (transportEl!.value as "stdio" | "http" | "sse") || (String(fd.get("transport") ?? "stdio") as "stdio" | "http" | "sse");
    const enabled = String(fd.get("enabled") ?? "true") === "true";
    const description = String(fd.get("description") ?? "").trim();

    if (!id) {
      if (errBox) { errBox.textContent = "ID is required."; errBox.hidden = false; }
      if (submitBtnEl) submitBtnEl.disabled = false;
      return;
    }

    const payload: McpAddServerRequest = { id, name, transport, enabled };
    if (description) payload.description = description;
    else if (isEdit) payload.description = ""; // allow clearing description on edit

    // Helper to strip placeholder "***" secrets — backend also strips, but do it early for patch clarity
    function filterPlaceholders(obj?: Record<string, string>): Record<string, string> | undefined {
      if (!obj) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === "***") continue;
        out[k] = v;
      }
      return Object.keys(out).length ? out : undefined;
    }

    if (transport === "stdio") {
      const command = String(fd.get("command") ?? "").trim();
      const argsStr = String(fd.get("args") ?? "");
      const cwd = String(fd.get("cwd") ?? "").trim();
      const envStr = String(fd.get("env") ?? "");
      const args = parseArgs(argsStr);
      const rawEnv = parseEnv(envStr);
      const env = filterPlaceholders(rawEnv);
      // basic client validation mirrors server validation but server is source of truth
      if (!command) {
        if (errBox) { errBox.textContent = "Command is required for stdio transport."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      payload.stdio = {
        command,
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
        ...(cwd ? { cwd } : {}),
      };
      // When editing and env was placeholder-only, omit env to preserve existing
      if (isEdit && rawEnv && !env) {
        // rawEnv had only "***" placeholders -> don't send env in patch
        delete (payload.stdio as Record<string, unknown>).env;
      }
    } else {
      const url = String(fd.get("url") ?? "").trim();
      const timeoutStr = String(fd.get("timeoutSeconds") ?? "").trim();
      const headersStr = String(fd.get("headers") ?? "");
      if (!url) {
        if (errBox) { errBox.textContent = "URL is required for http/sse transport."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      const rawHeaders = parseHeaders(headersStr);
      const headers = filterPlaceholders(rawHeaders);
      const timeoutSeconds = timeoutStr ? Number(timeoutStr) : undefined;
      if (timeoutStr && (Number.isNaN(timeoutSeconds) || timeoutSeconds! <= 0 || timeoutSeconds! > 300)) {
        if (errBox) { errBox.textContent = "Timeout must be 1..300 seconds."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      const httpPayload: McpAddServerRequest["http"] = {
        url,
        ...(headers ? { headers } : {}),
        ...(timeoutSeconds ? { timeoutSeconds } : {}),
      };
      if (transport === "sse") {
        payload.sse = httpPayload;
        // keep http for compatibility — server normalizes http/sse
        payload.http = httpPayload;
      } else {
        payload.http = httpPayload;
      }
      if (isEdit && rawHeaders && !headers) {
        if (payload.http) delete payload.http.headers;
        if (payload.sse) delete payload.sse.headers;
      }
    }

    // New servers are not added directly: show a summary of exactly what will be
    // spawned / connected to and require explicit confirmation first.
    if (!isEdit) {
      showConfirm(payload);
      if (submitBtnEl) submitBtnEl.disabled = false;
      return;
    }

    try {
      // PATCH via registry.update — send patch without id (id immutable)
      const { id: _omit, transport: _tOmit, ...patch } = payload;
      await window.api.mcpUpdateServer(id, patch);
      close();
      await loadMcpServers();
    } catch (err) {
      const msg = errorText(err);
      if (errBox) { errBox.textContent = msg; errBox.hidden = false; }
    } finally {
      if (submitBtnEl) submitBtnEl.disabled = false;
    }
  });
}

// ---- Assistant dialog -----------------------------------------------------

function parseStop(input: string): string[] | undefined {
  const t = input.trim();
  if (!t) return undefined;
  const parts = t.includes(",") ? t.split(",") : t.split("\n");
  const arr = parts.map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}

function parseFloatField(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function parseIntField(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isInteger(n) ? n : undefined;
}

function setupAssistantDialog(): void {
  const dialog = document.getElementById(ASSISTANT_DIALOG_ID) as HTMLDialogElement | null;
  const addBtn = document.getElementById(ASSISTANT_ADD_BTN_ID) as HTMLButtonElement | null;
  const closeBtn = document.getElementById(ASSISTANT_DIALOG_CLOSE_ID) as HTMLButtonElement | null;
  const cancelBtn = document.getElementById(ASSISTANT_CANCEL_BTN_ID) as HTMLButtonElement | null;
  const form = document.getElementById(ASSISTANT_FORM_ID) as HTMLFormElement | null;
  const errBox = document.getElementById(ASSISTANT_FORM_ERROR_ID);
  const dialogTitle = document.getElementById("assistant-dialog-title");
  const submitBtn = document.getElementById("assistant-submit-btn") as HTMLButtonElement | null;
  const idInput = document.getElementById("assistant-id") as HTMLInputElement | null;
  if (!dialog || !addBtn || !form) return;

  function setDialogMode(mode: "add" | "edit"): void {
    if (dialogTitle) dialogTitle.textContent = mode === "edit" ? "Edit Assistant" : "Add Assistant";
    if (submitBtn) submitBtn.textContent = mode === "edit" ? "Save changes" : "Add assistant";
  }

  function open(): void {
    editingAssistantId = null;
    setDialogMode("add");
    if (errBox) { errBox.textContent = ""; errBox.hidden = true; }
    form!.reset();
    if (idInput) { idInput.disabled = false; idInput.removeAttribute("aria-disabled"); }
    // ensure advanced details closed on add? keep as is
    if (typeof dialog!.showModal === "function") dialog!.showModal();
    else (dialog as unknown as { open: boolean }).open = true;
  }

  function openForEdit(assistant: AssistantSafe): void {
    editingAssistantId = assistant.id;
    setDialogMode("edit");
    if (errBox) { errBox.textContent = ""; errBox.hidden = true; }
    form!.reset();

    const idEl = document.getElementById("assistant-id") as HTMLInputElement | null;
    const nameEl = document.getElementById("assistant-name") as HTMLInputElement | null;
    const emojiEl = document.getElementById("assistant-emoji") as HTMLInputElement | null;
    const descEl = document.getElementById("assistant-desc") as HTMLInputElement | null;
    const instrEl = document.getElementById("assistant-instructions") as HTMLTextAreaElement | null;
    const enabledEl = document.getElementById("assistant-enabled") as HTMLSelectElement | null;
    const providerEl = document.getElementById("assistant-providerId") as HTMLInputElement | null;
    const modelEl = document.getElementById("assistant-model") as HTMLInputElement | null;
    if (idEl) { idEl.value = assistant.id; idEl.disabled = true; }
    if (nameEl) nameEl.value = assistant.name;
    if (emojiEl) emojiEl.value = assistant.emoji ?? "";
    if (descEl) descEl.value = assistant.description ?? "";
    if (instrEl) instrEl.value = assistant.instructions ?? "";
    if (enabledEl) enabledEl.value = assistant.enabled ? "true" : "false";
    if (providerEl) providerEl.value = assistant.providerId ?? "";
    if (modelEl) modelEl.value = assistant.model ?? "";

    const p = assistant.parameters ?? {};
    (document.getElementById("assistant-temperature") as HTMLInputElement | null)!.value = p.temperature !== undefined ? String(p.temperature) : "";
    (document.getElementById("assistant-topP") as HTMLInputElement | null)!.value = p.topP !== undefined ? String(p.topP) : "";
    (document.getElementById("assistant-topK") as HTMLInputElement | null)!.value = p.topK !== undefined ? String(p.topK) : "";
    (document.getElementById("assistant-minP") as HTMLInputElement | null)!.value = p.minP !== undefined ? String(p.minP) : "";
    (document.getElementById("assistant-frequencyPenalty") as HTMLInputElement | null)!.value = p.frequencyPenalty !== undefined ? String(p.frequencyPenalty) : "";
    (document.getElementById("assistant-presencePenalty") as HTMLInputElement | null)!.value = p.presencePenalty !== undefined ? String(p.presencePenalty) : "";
    (document.getElementById("assistant-repeatPenalty") as HTMLInputElement | null)!.value = p.repeatPenalty !== undefined ? String(p.repeatPenalty) : "";
    (document.getElementById("assistant-maxTokens") as HTMLInputElement | null)!.value = p.maxTokens !== undefined ? String(p.maxTokens) : "";
    (document.getElementById("assistant-seed") as HTMLInputElement | null)!.value = p.seed !== undefined ? String(p.seed) : "";
    (document.getElementById("assistant-stop") as HTMLInputElement | null)!.value = p.stop?.join(", ") ?? "";

    if (typeof dialog!.showModal === "function") dialog!.showModal();
    else (dialog as unknown as { open: boolean }).open = true;
  }

  openAssistantEdit = openForEdit;

  function close(): void {
    if (typeof dialog!.close === "function") {
      try { dialog!.close(); } catch { dialog!.removeAttribute("open"); }
    } else dialog!.removeAttribute("open");
    editingAssistantId = null;
    if (idInput) idInput.disabled = false;
    setDialogMode("add");
  }

  addBtn.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  cancelBtn?.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    editingAssistantId = null;
    if (idInput) idInput.disabled = false;
    setDialogMode("add");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errBox) { errBox.textContent = ""; errBox.hidden = true; }
    const submitBtnEl = document.getElementById("assistant-submit-btn") as HTMLButtonElement | null;
    if (submitBtnEl) submitBtnEl.disabled = true;

    const isEdit = editingAssistantId !== null;
    const fd = new FormData(form);
    const rawId = (fd.get("id") as string | null)?.trim() ?? "";
    const id = isEdit ? editingAssistantId! : rawId;
    const name = String(fd.get("name") ?? "").trim();
    const emoji = String(fd.get("emoji") ?? "").trim();
    const description = String(fd.get("description") ?? "").trim();
    const instructions = String(fd.get("instructions") ?? "").trim();
    const enabled = String(fd.get("enabled") ?? "true") === "true";
    const providerId = String(fd.get("providerId") ?? "").trim();
    const model = String(fd.get("model") ?? "").trim();

    if (!id) {
      if (errBox) { errBox.textContent = "ID is required."; errBox.hidden = false; }
      if (submitBtnEl) submitBtnEl.disabled = false;
      return;
    }
    if (!name) {
      if (errBox) { errBox.textContent = "Name is required."; errBox.hidden = false; }
      if (submitBtnEl) submitBtnEl.disabled = false;
      return;
    }
    if (!instructions) {
      if (errBox) { errBox.textContent = "Instructions are required."; errBox.hidden = false; }
      if (submitBtnEl) submitBtnEl.disabled = false;
      return;
    }

    // Build parameters — only include if user provided value
    const params: AssistantParametersWire = {};
    const tempRaw = String(fd.get("temperature") ?? "").trim();
    const topPRaw = String(fd.get("topP") ?? "").trim();
    const topKRaw = String(fd.get("topK") ?? "").trim();
    const minPRaw = String(fd.get("minP") ?? "").trim();
    const freqRaw = String(fd.get("frequencyPenalty") ?? "").trim();
    const presRaw = String(fd.get("presencePenalty") ?? "").trim();
    const repeatRaw = String(fd.get("repeatPenalty") ?? "").trim();
    const maxTokensRaw = String(fd.get("maxTokens") ?? "").trim();
    const seedRaw = String(fd.get("seed") ?? "").trim();
    const stopRaw = String(fd.get("stop") ?? "");

    if (tempRaw) {
      const v = parseFloatField(tempRaw);
      if (v === undefined || v < 0 || v > 2) {
        if (errBox) { errBox.textContent = "Temperature must be 0..2."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      params.temperature = v;
    }
    if (topPRaw) {
      const v = parseFloatField(topPRaw);
      if (v === undefined || v < 0 || v > 1) {
        if (errBox) { errBox.textContent = "Top P must be 0..1."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      params.topP = v;
    }
    if (topKRaw) {
      const v = parseIntField(topKRaw);
      if (v === undefined || v < 0 || v > 100) {
        if (errBox) { errBox.textContent = "Top K must be integer 0..100."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      params.topK = v;
    }
    if (minPRaw) {
      const v = parseFloatField(minPRaw);
      if (v === undefined || v < 0 || v > 1) {
        if (errBox) { errBox.textContent = "Min P must be 0..1."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      params.minP = v;
    }
    if (freqRaw) {
      const v = parseFloatField(freqRaw);
      if (v === undefined || v < -2 || v > 2) {
        if (errBox) { errBox.textContent = "Frequency penalty must be -2..2."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      params.frequencyPenalty = v;
    }
    if (presRaw) {
      const v = parseFloatField(presRaw);
      if (v === undefined || v < -2 || v > 2) {
        if (errBox) { errBox.textContent = "Presence penalty must be -2..2."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      params.presencePenalty = v;
    }
    if (repeatRaw) {
      const v = parseFloatField(repeatRaw);
      if (v === undefined || v < 0 || v > 2) {
        if (errBox) { errBox.textContent = "Repeat penalty must be 0..2."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      params.repeatPenalty = v;
    }
    if (maxTokensRaw) {
      const v = parseIntField(maxTokensRaw);
      if (v === undefined || v <= 0 || v > 200_000) {
        if (errBox) { errBox.textContent = "Max tokens must be 1..200000."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      params.maxTokens = v;
    }
    if (seedRaw) {
      const v = parseIntField(seedRaw);
      if (v === undefined || v < 0 || v > 2147483647) {
        if (errBox) { errBox.textContent = "Seed must be 0..2147483647."; errBox.hidden = false; }
        if (submitBtnEl) submitBtnEl.disabled = false;
        return;
      }
      params.seed = v;
    }
    const stop = parseStop(stopRaw);
    if (stop) params.stop = stop;

    const payload: AssistantAddRequest = {
      id,
      name,
      instructions,
      enabled,
    };
    if (description) payload.description = description;
    else if (isEdit) payload.description = "";
    if (emoji) payload.emoji = emoji;
    else if (isEdit) payload.emoji = "";
    if (providerId) payload.providerId = providerId;
    else if (isEdit) payload.providerId = "";
    if (model) payload.model = model;
    else if (isEdit) payload.model = "";
    if (Object.keys(params).length > 0) payload.parameters = params;
    else if (isEdit) {
      // For edit, if user cleared all params fields, we should not send parameters at all
      // to preserve existing — or if they explicitly cleared, send empty? Keep no-op for now.
    }

    try {
      if (isEdit) {
        const { id: _omit, ...patch } = payload;
        // For edit, we patch — id immutable. Ensure we send patch with possibly empty strings for clearing.
        // If parameters were omitted and existing has parameters, they will be preserved via merge.
        // To allow clearing individual params, user would need to re-specify params without that key — merge will preserve old key.
        // For full replace, we could send parameters as provided only.
        await window.api.assistantUpdate(id, patch);
      } else {
        await window.api.assistantAdd(payload);
      }
      close();
      await loadAssistants();
    } catch (err) {
      const msg = errorText(err);
      if (errBox) { errBox.textContent = msg; errBox.hidden = false; }
    } finally {
      if (submitBtnEl) submitBtnEl.disabled = false;
    }
  });
}

async function init(): Promise<void> {
  const content = document.getElementById(CONTENT_ID);
  if (!content) return;

  // If API is unavailable (opened without preload), show a clear message.
  if (!window.api?.aiListProviders) {
    content.replaceChildren(
      el("p", "load-error", "The connection status page is unavailable because the app's preload API could not be loaded. Please relaunch the application."),
    );
    return;
  }

  try {
    const providers = await window.api.aiListProviders();
    if (providers.length === 0) {
      content.replaceChildren(el("p", "load-error", "No AI providers are configured. Add a provider (such as Ollama) to see its connection status here."));
    } else {
      cards = providers.map(createProviderCard);
      renderContent();
    }
  } catch (e) {
    content.replaceChildren(el("p", "load-error", `Failed to load providers: ${errorText(e)}`));
  }

  document
    .getElementById(REFRESH_BTN_ID)
    ?.addEventListener("click", () => void refreshAll(true));

  // Auto-refresh health on a timer; models refresh on an explicit "Check now".
  setInterval(() => {
    void refreshAllHealth();
  }, REFRESH_INTERVAL_MS);

  if (cards.length > 0) await refreshAll(true);

  // Keep the "seconds ago" label ticking every second.
  setInterval(updateLastCheck, 1000);

  // ---- MCP init (independent of AI providers) ----
  document.getElementById(MCP_REFRESH_BTN_ID)?.addEventListener("click", () => void refreshAllMcp(true));
  setupMcpDialog();
  await loadMcpServers();
  setInterval(() => {
    void refreshAllMcpHealth();
  }, REFRESH_INTERVAL_MS);
  setInterval(updateMcpLastCheck, 1000);

  // ---- Assistant init (independent) ----
  document.getElementById(ASSISTANT_REFRESH_BTN_ID)?.addEventListener("click", () => void refreshAssistants(true));
  setupAssistantDialog();
  await loadAssistants();
  setInterval(updateAssistantLastCheck, 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
