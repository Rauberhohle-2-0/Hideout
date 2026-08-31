/**
 * Chat interface.
 *
 * A single-threaded chat view: pick a model (and optionally an assistant) from
 * the right-hand panel, type a message, and watch the answer stream in. Chat
 * requests go through `window.api.aiChatStream`, which drives the sidecar's
 * agent tool-loop — so MCP tools (e.g. Exa by default) can answer the model's
 * function calls inline.
 */

import type {
  AiProviderInfo,
  Api,
  AssistantSafe,
  ChatStreamEvent,
  ChatStreamHandlers,
} from "../shared/api.ts";
// The runtime's appWindow powers title-bar drag and double-click-to-zoom.
import { appWindow } from "@vantail/api";

declare global {
  interface Window {
    api: Api;
  }
}

const PROVIDER_ID = "ollama";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

interface ModelOption {
  id: string;
  name: string;
}

let models: ModelOption[] = [];
let assistants: AssistantSafe[] = [];
let selectedModel: string | undefined;
let selectedAssistantId: string | undefined;
let streaming = false;

// ---- DOM helpers ----------------------------------------------------------

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

async function firstCapableProvider(): Promise<AiProviderInfo | undefined> {
  try {
    const providers = await window.api.aiListProviders();
    return providers.find((p) => p.capabilities?.chat) ?? providers[0];
  } catch (e) {
    return undefined;
  }
}

async function loadModels(): Promise<void> {
  try {
    const provider = await firstCapableProvider();
    const providerId = provider?.id ?? PROVIDER_ID;
    const raw = await window.api.aiListModels(providerId);
    models = raw.map((m) => ({ id: m.id, name: m.name }));
    if (models.length > 0 && !selectedModel) {
      // Default: the first model, or the provider's configured default.
      const def = provider?.config?.defaultModel;
      selectedModel = models.some((m) => m.id === def) ? def : models[0]!.id;
    }
  } catch (e) {
    models = [];
    console.error("model load failed:", errorText(e));
  }
  renderModelPanel();
  renderModelButton();
}

async function loadAssistants(): Promise<void> {
  try {
    assistants = await window.api.assistantList();
  } catch (e) {
    assistants = [];
    console.error("assistant load failed:", errorText(e));
  }
  renderAssistantPanel();
}

// ---- Chat rendering -------------------------------------------------------

function setView(hasMessages: boolean): void {
  const empty = $("empty-state");
  const messages = $("messages");
  if (hasMessages) {
    empty.hidden = true;
    messages.toggleAttribute("shown", true);
  } else {
    messages.toggleAttribute("shown", false);
    messages.innerHTML = "";
    empty.hidden = false;
  }
}

function appendUserBubble(text: string): void {
  const list = $<HTMLDivElement>("messages");
  const msg = el("div", "msg user");
  msg.append(el("div", "bubble", text));
  list.append(msg);
  scrollToBottom();
}

function appendAssistantContainer(): HTMLDivElement {
  const list = $<HTMLDivElement>("messages");
  const msg = el("div", "msg assistant");
  const meta = el("div", "meta", selectedModel ?? "");
  const bubble = el("div", "bubble", "");
  msg.append(meta);
  msg.append(bubble);
  const toolArea = el("div") as HTMLDivElement;
  msg.append(toolArea);
  list.append(msg);
  scrollToBottom();
  return msg as HTMLDivElement;
}

function scrollToBottom(): void {
  const list = $<HTMLDivElement>("messages");
  list.scrollTop = list.scrollHeight;
}

function renderToolActivity(container: HTMLElement, toolStart: ChatStreamEvent & { type: "tool_start" }): void {
  const line = el("div", "tool-line");
  line.dataset.tool = toolStart.tool;
  const spin = el("span") as HTMLSpanElement;
  spin.className = "spin";
  const label = el("span", undefined, `Using ${toolStart.tool}…`);
  line.append(spin, label);
  container.append(line);
}

function finishToolLine(container: HTMLElement, tool: string, ok: boolean, result: string): void {
  const line = container.querySelector(`.tool-line[data-tool="${tool}"]`);
  if (line) {
    line.querySelector(".spin")?.remove();
    line.append(el("span", undefined, ok ? `✓ ${tool}` : `✗ ${tool}`));
  }
}

function errorBubble(text: string, container?: HTMLElement): void {
  const list = $<HTMLDivElement>("messages");
  const msg = el("div", "msg assistant");
  const bubble = el("div", "bubble", text);
  bubble.style.color = "var(--err)";
  if (container) container.append(bubble);
  else {
    msg.append(bubble);
    list.append(msg);
  }
  scrollToBottom();
}

// ---- Chat send logic ------------------------------------------------------

function buildRequest(text: string) {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "user", content: text }];
  if (selectedAssistantId) {
    const assistant = assistants.find((a) => a.id === selectedAssistantId);
    if (assistant?.providerId) {
      // Adhere: use the assistant's provider if it specifies one.
      return {
        providerId: assistant.providerId,
        messages,
        model: assistant.model ?? selectedModel,
        assistantId: assistant.id,
      };
    }
  }
  return { providerId: PROVIDER_ID, messages, model: selectedModel, assistantId: selectedAssistantId };
}

async function sendMessage(): Promise<void> {
  const input = $<HTMLTextAreaElement>("chat-input");
  const text = input.value.trim();
  if (!text || streaming) return;
  input.value = "";
  input.style.height = "auto";

  appendUserBubble(text);
  const container = appendAssistantContainer();
  const bubble = (container.querySelector(".bubble") as HTMLElement) ?? container;
  let answer = "";

  setView(true);
  streaming = true;
  setSendEnabled(false);

  const body = buildRequest(text);
  const handlers: ChatStreamHandlers = {
    onEvent(event: ChatStreamEvent) {
      switch (event.type) {
        case "delta":
          answer += event.delta;
          bubble.textContent = answer;
          scrollToBottom();
          break;
        case "tool_start":
          renderToolActivity(container, event);
          scrollToBottom();
          break;
        case "tool_end":
          finishToolLine(container, event.tool, event.ok, event.result);
          scrollToBottom();
          break;
        case "error":
          errorBubble(event.error, container);
          break;
        default:
          break;
      }
    },
    onEnd() {
      bubble.textContent = answer || bubble.textContent || "(empty reply)";
      streaming = false;
      setSendEnabled(true);
    },
  };

  try {
    await window.api.aiChatStream(body, handlers);
  } catch (e) {
    errorBubble(`Chat failed: ${errorText(e)}`, container);
    streaming = false;
    setSendEnabled(true);
  }
}

function setSendEnabled(enabled: boolean): void {
  $<HTMLButtonElement>("composer-send").disabled = !enabled;
}

// ---- Panels ---------------------------------------------------------------

function renderModelPanel(): void {
  const list = $<HTMLDivElement>("model-list");
  list.replaceChildren();
  if (models.length === 0) {
    list.append(el("div", "side-item", "No models found"));
    return;
  }
  for (const m of models) {
    const btn = el("button", "side-item") as HTMLButtonElement;
    btn.type = "button";
    btn.classList.toggle("selected", m.id === selectedModel);
    btn.append(el("span", undefined, m.name));
    btn.append(el("span", "grip", "Ollama"));
    btn.addEventListener("click", () => {
      selectedModel = m.id;
      renderModelPanel();
      renderModelButton();
      closeModelMenu();
    });
    list.append(btn);
  }
}

function renderAssistantPanel(): void {
  const list = $<HTMLDivElement>("assistant-list");
  list.replaceChildren();
  const none = el("button", "side-item") as HTMLButtonElement;
  none.type = "button";
  none.classList.toggle("selected", !selectedAssistantId);
  none.append(el("span", undefined, "None"));
  none.addEventListener("click", () => {
    selectedAssistantId = undefined;
    renderAssistantPanel();
  });
  list.append(none);
  for (const a of assistants) {
    const btn = el("button", "side-item") as HTMLButtonElement;
    btn.type = "button";
    btn.classList.toggle("selected", a.id === selectedAssistantId);
    btn.append(el("span", undefined, `${a.emoji ?? ""} ${a.name}`.trim()));
    btn.append(el("span", "grip", a.model ?? ""));
    btn.addEventListener("click", () => {
      selectedAssistantId = a.id;
      renderAssistantPanel();
      if (a.model) {
        selectedModel = a.model;
        renderModelPanel();
      }
      renderModelButton();
    });
    list.append(btn);
  }
}

function renderModelButton(): void {
  const label = $("composer-model-label");
  label.textContent = selectedModel ?? "Choose model";
}

// ---- Model menu popover ---------------------------------------------------

function openModelMenu(anchor: HTMLElement): void {
  closeModelMenu();
  const menu = $<HTMLDivElement>("model-menu");
  menu.replaceChildren();
  for (const m of models) {
    const item = el("button", "menu-item") as HTMLButtonElement;
    item.type = "button";
    item.classList.toggle("selected", m.id === selectedModel);
    item.append(el("span", undefined, m.name));
    item.addEventListener("click", () => {
      selectedModel = m.id;
      renderModelButton();
      renderModelPanel();
      closeModelMenu();
    });
    menu.append(item);
  }
  if (models.length === 0) {
    menu.append(el("button", "menu-item", "No models installed") as HTMLButtonElement);
  }
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
}

function closeModelMenu(): void {
  $<HTMLDivElement>("model-menu").hidden = true;
}

// ---- Title bar (drag + double-click to zoom) -------------------------------

function setupTitleBar(): void {
  const bar = document.getElementById("titlebar");
  if (!bar) return;
  bar.addEventListener("pointerdown", (event) => {
    if ((event.target as Element).closest("button, input, a, select, textarea")) return;
    if (event.buttons === 1) void appWindow.startDragging();
  });
  bar.addEventListener("dblclick", (event) => {
    if ((event.target as Element).closest("button, input, a, select, textarea")) return;
    void appWindow.toggleMaximize();
  });
}

// ---- init -----------------------------------------------------------------

async function init(): Promise<void> {
  setupTitleBar();

  try {
    await Promise.all([loadModels(), loadAssistants()]);
  } catch (e) {
    console.error("init failed:", errorText(e));
  }

  const input = $<HTMLTextAreaElement>("chat-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });
  $<HTMLButtonElement>("composer-send").addEventListener("click", () => void sendMessage());
  $<HTMLButtonElement>("composer-model").addEventListener("click", (e) => {
    openModelMenu(e.currentTarget as HTMLElement);
  });
  $<HTMLButtonElement>("sidebar-toggle-btn").addEventListener("click", () => {
    $<HTMLElement>("side-panel").classList.toggle("collapsed");
  });
  $<HTMLButtonElement>("new-chat-btn").addEventListener("click", () => {
    setView(false);
  });
  document.addEventListener("click", (e) => {
    const target = e.target as Node;
    if (!$<HTMLElement>("model-menu").contains(target) && !$<HTMLElement>("composer-model").contains(target)) {
      closeModelMenu();
    }
  });

  setSendEnabled(true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
