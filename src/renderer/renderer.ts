import type { Api, AiProviderInfo, McpServerSafe } from "../shared/api.ts";

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

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    render();

    try {
      health = await window.api.aiHealth(provider.id);

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
    } catch (e) {
      health = { ok: false, error: errorText(e) };
      models = null;
    } finally {
      busy = false;
      render();
    }
  }

  render();
  return { provider, element: card, refresh, setBusy: (b: boolean) => void (busy = b) };
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
}

function createMcpCard(server: McpServerSafe, onChanged: () => Promise<void>): McpCard {
  let health: McpHealthResult | null = null;
  let tools: Array<{ name: string; description?: string }> | null = null;
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
  actions.append(connectBtn, toggleBtn, removeBtn);
  card.append(actions);

  function render(): void {
    const isDisabled = server.enabled === false;
    if (busy) {
      dot.className = "status-dot status-checking";
      statusText.className = "status-text";
      statusText.textContent = "Checking…";
      connectBtn.disabled = true;
      toggleBtn.disabled = true;
      removeBtn.disabled = true;
    } else if (isDisabled) {
      dot.className = "status-dot status-unknown";
      statusText.className = "status-text";
      statusText.textContent = "Disabled";
      connectBtn.disabled = true;
      toggleBtn.disabled = false;
      removeBtn.disabled = false;
    } else if (!health) {
      dot.className = "status-dot status-unknown";
      statusText.className = "status-text";
      statusText.textContent = "Not checked yet";
      connectBtn.disabled = false;
      toggleBtn.disabled = false;
      removeBtn.disabled = false;
    } else if (health.ok) {
      dot.className = "status-dot status-ok";
      statusText.className = "status-text status-ok-c";
      statusText.textContent = health.version ? `Connected · v${health.version}` : "Connected";
      connectBtn.disabled = false;
      toggleBtn.disabled = false;
      removeBtn.disabled = false;
    } else {
      dot.className = "status-dot status-error";
      statusText.className = "status-text status-err";
      statusText.textContent = "Connection failed";
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
        const li = el("li", "model-item");
        li.append(el("span", "model-name", t.name));
        if (t.description) li.append(el("span", "model-id", t.description));
        else if (t.name) {
          // keep layout consistent — no second span
        }
        toolsList.append(li);
      }
    } else {
      toolsTitle.textContent = "Tools";
    }
  }

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      health = await window.api.mcpHealth(server.id);
      if (health.ok) {
        try {
          const raw = await window.api.mcpListTools(server.id);
          tools = raw.map((t) => ({ name: t.name, description: t.description }));
        } catch (e) {
          tools = [];
          // keep health green but surface warning in error box as info? keep as-is
          // Don't overwrite health.ok — just keep tools empty and optionally show error in list
          // To avoid confusing red state, we don't set health error when tools fail
          void errorText(e);
        }
      } else {
        tools = null;
      }
    } catch (e) {
      health = { ok: false, error: errorText(e) };
      tools = null;
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
      if (window.api.mcpSetEnabled) {
        await window.api.mcpSetEnabled(server.id, nextEnabled);
      } else {
        // fallback for old preload: use patch
        await window.api.mcpUpdateServer(server.id, { enabled: nextEnabled } as never);
      }
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

  render();
  return { server, element: card, refresh };
}

// ---- page level ------------------------------------------------------------

let cards: ProviderCard[] = [];
let lastCheck = 0;

let mcpCards: McpCard[] = [];
let mcpLastCheck = 0;

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

  function open(): void {
    if (errBox) { errBox.textContent = ""; errBox.hidden = true; }
    form!.reset();
    // reset transport default to stdio
    transportEl!.value = "stdio";
    updateTransportFields();
    // default enabled true handled by form reset
    if (typeof dialog!.showModal === "function") dialog!.showModal();
    else (dialog as unknown as { open: boolean }).open = true;
  }
  function close(): void {
    if (typeof dialog!.close === "function") {
      try { dialog!.close(); } catch { dialog!.removeAttribute("open"); }
    } else dialog!.removeAttribute("open");
  }

  addBtn.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  cancelBtn?.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target === dialog) close();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errBox) { errBox.textContent = ""; errBox.hidden = true; }
    const submitBtn = document.getElementById("mcp-submit-btn") as HTMLButtonElement | null;
    if (submitBtn) submitBtn.disabled = true;

    const fd = new FormData(form);
    const id = String(fd.get("id") ?? "").trim();
    const name = String(fd.get("name") ?? "").trim();
    const transport = String(fd.get("transport") ?? "stdio") as "stdio" | "http" | "sse";
    const enabled = String(fd.get("enabled") ?? "true") === "true";
    const description = String(fd.get("description") ?? "").trim();

    let payload: Record<string, unknown> = { id, name, transport, enabled };
    if (description) payload.description = description;

    if (transport === "stdio") {
      const command = String(fd.get("command") ?? "").trim();
      const argsStr = String(fd.get("args") ?? "");
      const cwd = String(fd.get("cwd") ?? "").trim();
      const envStr = String(fd.get("env") ?? "");
      const args = parseArgs(argsStr);
      const env = parseEnv(envStr);
      // basic client validation mirrors server validation but server is source of truth
      if (!command) {
        if (errBox) { errBox.textContent = "Command is required for stdio transport."; errBox.hidden = false; }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      payload.stdio = {
        command,
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
        ...(cwd ? { cwd } : {}),
      };
    } else {
      const url = String(fd.get("url") ?? "").trim();
      const timeoutStr = String(fd.get("timeoutSeconds") ?? "").trim();
      const headersStr = String(fd.get("headers") ?? "");
      if (!url) {
        if (errBox) { errBox.textContent = "URL is required for http/sse transport."; errBox.hidden = false; }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      const headers = parseHeaders(headersStr);
      const timeoutSeconds = timeoutStr ? Number(timeoutStr) : undefined;
      if (timeoutStr && (Number.isNaN(timeoutSeconds) || timeoutSeconds! <= 0 || timeoutSeconds! > 300)) {
        if (errBox) { errBox.textContent = "Timeout must be 1..300 seconds."; errBox.hidden = false; }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      const httpPayload: Record<string, unknown> = { url, ...(headers ? { headers } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) };
      if (transport === "sse") {
        payload.sse = httpPayload;
        // keep http for compatibility — server normalizes http/sse
        payload.http = httpPayload;
      } else {
        payload.http = httpPayload;
      }
    }

    try {
      await window.api.mcpAddServer(payload as never);
      close();
      await loadMcpServers();
    } catch (err) {
      const msg = errorText(err);
      // Strip code prefix if present e.g. "CONFIG_INVALID: ..."
      if (errBox) { errBox.textContent = msg; errBox.hidden = false; }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
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

  // Auto-refresh periodically so the status stays current.
  setInterval(() => {
    void refreshAll(false);
    updateLastCheck();
  }, REFRESH_INTERVAL_MS);

  if (cards.length > 0) await refreshAll(true);

  // Keep the "seconds ago" label ticking every second.
  setInterval(updateLastCheck, 1000);

  // ---- MCP init (independent of AI providers) ----
  document.getElementById(MCP_REFRESH_BTN_ID)?.addEventListener("click", () => void refreshAllMcp(true));
  setupMcpDialog();
  await loadMcpServers();
  setInterval(() => {
    void refreshAllMcp(false);
    updateMcpLastCheck();
  }, REFRESH_INTERVAL_MS);
  setInterval(updateMcpLastCheck, 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
