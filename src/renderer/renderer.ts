import type { Api, AiProviderInfo } from "../shared/api.ts";

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

// ---- page level ------------------------------------------------------------

let cards: ProviderCard[] = [];
let lastCheck = 0;

function setLoading(loading: boolean, text: string): void {
  const icon = document.getElementById(REFRESH_ICON_ID);
  const btn = document.getElementById(REFRESH_BTN_ID) as HTMLButtonElement | null;
  if (icon) icon.style.display = loading ? "" : "none";
  if (btn) btn.disabled = loading;
  void text; // keep for potential future use
}

function updateLastCheck(): void {
  const node = document.getElementById(LAST_CHECK_ID);
  if (!node || lastCheck === 0) return;
  const dt = new Date(lastCheck);
  const t = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const ago = Math.max(0, Math.round((Date.now() - lastCheck) / 1000));
  node.textContent = `Last checked at ${t} · ${ago}s ago`;
}

function renderContent(): void {
  const content = document.getElementById(CONTENT_ID);
  content?.replaceChildren();
  for (const c of cards) content?.append(c.element);
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
      return;
    }
    cards = providers.map(createProviderCard);
    renderContent();
  } catch (e) {
    content.replaceChildren(el("p", "load-error", `Failed to load providers: ${errorText(e)}`));
    return;
  }

  document
    .getElementById(REFRESH_BTN_ID)
    ?.addEventListener("click", () => void refreshAll(true));

  // Auto-refresh periodically so the status stays current.
  setInterval(() => {
    void refreshAll(false);
    updateLastCheck();
  }, REFRESH_INTERVAL_MS);

  await refreshAll(true);

  // Keep the "seconds ago" label ticking every second.
  setInterval(updateLastCheck, 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}