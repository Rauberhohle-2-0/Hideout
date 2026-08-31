/**
 * Chat interface — conversation history, pinning, and a streaming agentic
 * chat. The left sidebar lists every chat (pinned first), the composer picks
 * the model, the assistant, and whether MCP tools (Exa by default) may be
 * called, and answers stream in token by token through the sidecar's agent
 * tool-loop (window.api.aiChatStream).
 */

import type {
  AiProviderInfo,
  Api,
  AssistantSafe,
  ChatMessageWire,
  ChatSafe,
  ChatStreamEvent,
  ChatStreamHandlers,
} from "../shared/api.ts";
// The runtime's appWindow powers title-bar drag and double-click-to-zoom; the
// native dialog confirms chat deletion.
import { appWindow, dialog } from "@vantail/api";

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
let chats: ChatSafe[] = [];
let selectedModel: string | undefined;
let selectedAssistantId: string | undefined;
let useTools = true; // Exa and friends are enabled by default
let activeChatId: string | undefined;
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

function chatIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M8 2a6 6 0 0 0-5.2 8.9L2 14l3.2-1a6 6 0 1 0 2.8-11Z",
  );
  svg.append(path);
  return svg;
}

function pinIcon(filled: boolean): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", filled ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M13 11.5 8 9l-5 2.5L8 2l5 9.5Z");
  svg.append(path);
  return svg;
}

function trashIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p1.setAttribute("d", "M2.5 4h11");
  const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p2.setAttribute("d", "M5.5 4V2.8A.8.8 0 0 1 6.3 2h3.4a.8.8 0 0 1 .8.8V4");
  const p3 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p3.setAttribute("d", "M12.5 4v9.2a.8.8 0 0 1-.8.8H4.3a.8.8 0 0 1-.8-.8V4");
  svg.append(p1, p2, p3);
  return svg;
}

// ---- Data loading ---------------------------------------------------------

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
      const def = provider?.config?.defaultModel;
      selectedModel = models.some((m) => m.id === def) ? def : models[0]!.id;
    }
  } catch (e) {
    models = [];
    console.error("model load failed:", errorText(e));
  }
  renderModelButton();
}

async function loadAssistants(): Promise<void> {
  try {
    assistants = await window.api.assistantList();
  } catch (e) {
    assistants = [];
    console.error("assistant load failed:", errorText(e));
  }
  renderAssistantButton();
}

async function loadChats(): Promise<void> {
  try {
    chats = await window.api.chatList();
  } catch (e) {
    chats = [];
    console.error("chat load failed:", errorText(e));
  }
  renderSidebar();
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

function scrollToBottom(): void {
  const list = $<HTMLDivElement>("messages");
  list.scrollTop = list.scrollHeight;
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

/** Re-render a stored chat's messages (used when opening a chat). */
function renderChatMessages(messages: ChatMessageWire[]): void {
  const list = $<HTMLDivElement>("messages");
  list.innerHTML = "";
  for (const m of messages) {
    if (m.role === "user") {
      const msg = el("div", "msg user");
      msg.append(el("div", "bubble", m.content));
      list.append(msg);
    } else {
      const msg = el("div", "msg assistant");
      msg.append(el("div", "meta", selectedModel ?? ""));
      msg.append(el("div", "bubble", m.content));
      list.append(msg);
    }
  }
  scrollToBottom();
}

/**
 * Stream reasoning text into a collapsible <details> that is collapsed by
 * default; the user can expand it to read the model's thinking.
 */
function renderReasoning(container: HTMLElement, text: string): void {
  let details = container.querySelector("details.reasoning") as HTMLDetailsElement | null;
  let body: HTMLElement;
  if (!details) {
    details = el("details", "reasoning") as HTMLDetailsElement;
    const summary = el("summary");
    summary.append(el("span", undefined, "Reasoning"));
    const spinner = el("span") as HTMLSpanElement;
    spinner.className = "reasoning-dot";
    summary.append(spinner);
    body = el("div", "reasoning-body");
    details.append(summary, body);
    const bubble = container.querySelector(".bubble");
    if (bubble) container.insertBefore(details, bubble);
    else container.append(details);
  } else {
    body = details.querySelector(".reasoning-body") as HTMLElement;
  }
  body.textContent += text;
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

function finishToolLine(container: HTMLElement, tool: string, ok: boolean): void {
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

// ---- Chat send + persistence ----------------------------------------------

function buildRequest(text: string, history: ChatMessageWire[]) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const assistant = selectedAssistantId ? assistants.find((a) => a.id === selectedAssistantId) : undefined;
  return {
    providerId: assistant?.providerId ?? PROVIDER_ID,
    messages,
    model: assistant?.model ?? selectedModel,
    assistantId: selectedAssistantId,
    useTools,
  };
}

async function persistExchange(userText: string, assistantText: string): Promise<void> {
  try {
    const base = activeChatId ? (chats.find((c) => c.id === activeChatId)?.messages ?? []) : [];
    const messages: ChatMessageWire[] = [...base, { role: "user", content: userText }];
    if (assistantText.trim()) messages.push({ role: "assistant", content: assistantText });

    const settings = {
      model: selectedModel,
      assistantId: selectedAssistantId,
      useTools,
    };
    if (activeChatId) {
      await window.api.chatUpdate(activeChatId, { messages, ...settings });
    } else {
      const created = await window.api.chatCreate({ messages, ...settings });
      activeChatId = created.id;
    }
    await loadChats();
  } catch (e) {
    console.error("chat persist failed:", errorText(e));
  }
}

async function sendMessage(): Promise<void> {
  const input = $<HTMLTextAreaElement>("chat-input");
  const text = input.value.trim();
  if (!text || streaming) return;
  input.value = "";
  input.style.height = "auto";

  const history: ChatMessageWire[] = [
    ...(activeChatId ? (chats.find((c) => c.id === activeChatId)?.messages ?? []) : []),
    { role: "user", content: text },
  ];

  appendUserBubble(text);
  const container = appendAssistantContainer();
  const bubble = (container.querySelector(".bubble") as HTMLElement) ?? container;
  let answer = "";

  setView(true);
  streaming = true;
  setSendEnabled(false);

  const body = buildRequest(text, history);
  const handlers: ChatStreamHandlers = {
    onEvent(event: ChatStreamEvent) {
      switch (event.type) {
        case "delta":
          // First real answer token: reasoning is done, its activity dot stops.
          container.querySelector("details.reasoning .reasoning-dot")?.remove();
          answer += event.delta;
          bubble.textContent = answer;
          scrollToBottom();
          break;
        case "reasoning":
          renderReasoning(container, event.delta);
          scrollToBottom();
          break;
        case "tool_start":
          renderToolActivity(container, event);
          scrollToBottom();
          break;
        case "tool_end":
          finishToolLine(container, event.tool, event.ok);
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
      void persistExchange(text, bubble.textContent === "(empty reply)" ? "" : answer);
    },
  };

  try {
    await window.api.aiChatStream(body, handlers);
  } catch (e) {
    errorBubble(`Chat failed: ${errorText(e)}`, container);
    streaming = false;
    setSendEnabled(true);
    void persistExchange(text, answer);
  }
}

function setSendEnabled(enabled: boolean): void {
  $<HTMLButtonElement>("composer-send").disabled = !enabled;
  $<HTMLButtonElement>("tools-toggle").disabled = !enabled;
}

// ---- Sidebar (chats) ------------------------------------------------------

function renderSidebar(): void {
  const pinned = chats.filter((c) => c.pinned);
  const recent = chats.filter((c) => !c.pinned);

  const pinnedList = $<HTMLDivElement>("pinned-list");
  const recentList = $<HTMLDivElement>("chats-list");
  $<HTMLElement>("pinned-section").hidden = pinned.length === 0;
  $<HTMLElement>("recent-section").hidden = chats.length === 0;
  pinnedList.replaceChildren(...pinned.map((c) => chatItem(c)));
  recentList.replaceChildren(...recent.map((c) => chatItem(c)));
}

function chatItem(chat: ChatSafe): HTMLElement {
  // A div (not a button): the row contains pin/delete buttons, and interactive
  // elements must not nest inside a button.
  const item = el("div", "chat-item") as HTMLDivElement;
  item.setAttribute("role", "button");
  item.tabIndex = 0;
  item.classList.toggle("active", chat.id === activeChatId);
  item.title = chat.title;

  const icon = el("span", "chat-icon");
  icon.append(chatIcon());
  const title = el("span", "chat-title", chat.title);

  const actions = el("div", "chat-actions") as HTMLDivElement;
  const pin = el("button") as HTMLButtonElement;
  pin.type = "button";
  pin.title = chat.pinned ? "Unpin" : "Pin";
  pin.setAttribute("aria-label", pin.title);
  if (chat.pinned) pin.classList.add("pinned");
  pin.append(pinIcon(chat.pinned));
  pin.addEventListener("click", (e) => {
    e.stopPropagation();
    if (streaming) return;
    void window.api.chatSetPinned(chat.id, !chat.pinned).then(loadChats).catch((err) => console.error("pin failed:", errorText(err)));
  });

  const del = el("button") as HTMLButtonElement;
  del.type = "button";
  del.title = "Delete chat";
  del.setAttribute("aria-label", del.title);
  del.append(trashIcon());
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    if (streaming) return;
    void (async () => {
      const ok = await dialog.confirm(`Delete "${chat.title}"?`, {
        title: "Delete chat",
        okLabel: "Delete",
        cancelLabel: "Cancel",
        kind: "warning",
      });
      if (!ok) return;
      try {
        await window.api.chatRemove(chat.id);
        if (activeChatId === chat.id) newChat();
        await loadChats();
      } catch (err) {
        console.error("delete failed:", errorText(err));
      }
    })();
  });

  actions.append(pin, del);
  item.append(icon, title, actions);
  item.addEventListener("click", () => {
    if (streaming) return;
    void openChat(chat.id);
  });
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (streaming) return;
      void openChat(chat.id);
    }
  });
  return item;
}

async function openChat(id: string): Promise<void> {
  activeChatId = id;
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  if (chat.model) selectedModel = chat.model;
  if (chat.assistantId) selectedAssistantId = chat.assistantId;
  if (chat.useTools !== undefined) useTools = chat.useTools;
  renderModelButton();
  renderAssistantButton();
  renderToolsToggle();
  renderChatMessages(chat.messages);
  setView(chat.messages.length > 0);
  renderSidebar();
}

function newChat(): void {
  activeChatId = undefined;
  setView(false);
  renderSidebar();
}

// ---- Composer controls ----------------------------------------------------

function renderModelButton(): void {
  $("composer-model-label").textContent = selectedModel ?? "Choose model";
}

function renderAssistantButton(): void {
  const assistant = selectedAssistantId ? assistants.find((a) => a.id === selectedAssistantId) : undefined;
  $("composer-assistant-label").textContent = assistant ? `${assistant.emoji ?? ""} ${assistant.name}`.trim() : "No assistant";
}

function renderToolsToggle(): void {
  const btn = $<HTMLButtonElement>("tools-toggle");
  btn.classList.toggle("on", useTools);
  btn.title = useTools ? "Tools on — MCP tools (e.g. Exa) may be called" : "Tools off — MCP tools are not offered to the model";
}

// ---- Popover menus --------------------------------------------------------

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
      closeModelMenu();
    });
    menu.append(item);
  }
  if (models.length === 0) {
    menu.append(el("button", "menu-item", "No models installed") as HTMLButtonElement);
  }
  positionMenu(menu, anchor);
}

function openAssistantMenu(anchor: HTMLElement): void {
  closeAssistantMenu();
  const menu = $<HTMLDivElement>("assistant-menu");
  menu.replaceChildren();

  const none = el("button", "menu-item") as HTMLButtonElement;
  none.type = "button";
  none.classList.toggle("selected", !selectedAssistantId);
  none.append(el("span", undefined, "No assistant"));
  none.addEventListener("click", () => {
    selectedAssistantId = undefined;
    renderAssistantButton();
    closeAssistantMenu();
  });
  menu.append(none);

  for (const a of assistants) {
    const item = el("button", "menu-item") as HTMLButtonElement;
    item.type = "button";
    item.classList.toggle("selected", a.id === selectedAssistantId);
    item.append(el("span", undefined, `${a.emoji ?? ""} ${a.name}`.trim()));
    item.addEventListener("click", () => {
      selectedAssistantId = a.id;
      renderAssistantButton();
      // Adhere: an assistant pinned to a model switches the model too.
      if (a.model) {
        selectedModel = a.model;
        renderModelButton();
      }
      closeAssistantMenu();
    });
    menu.append(item);
  }
  positionMenu(menu, anchor);
}

/**
 * Place a popover menu near its anchor, flipping to open *upward* when there
 * is not enough room below (the composer sits at the bottom of the window, so
 * a downward menu would render off-screen and lose its context).
 */
function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow < menu.offsetHeight + 8) {
    // Open upward: the menu's bottom edge sits just above the anchor's top.
    menu.style.top = "auto";
    menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  } else {
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.bottom = "auto";
  }
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
}

function closeModelMenu(): void {
  $<HTMLDivElement>("model-menu").hidden = true;
}

function closeAssistantMenu(): void {
  $<HTMLDivElement>("assistant-menu").hidden = true;
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
    await Promise.all([loadModels(), loadAssistants(), loadChats()]);
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
  $<HTMLButtonElement>("composer-assistant").addEventListener("click", (e) => {
    openAssistantMenu(e.currentTarget as HTMLElement);
  });
  $<HTMLButtonElement>("tools-toggle").addEventListener("click", () => {
    useTools = !useTools;
    renderToolsToggle();
  });
  $<HTMLButtonElement>("sidebar-toggle-btn").addEventListener("click", () => {
    $<HTMLElement>("sidebar").classList.toggle("collapsed");
  });
  $<HTMLButtonElement>("new-chat-btn").addEventListener("click", () => {
    if (streaming) return;
    newChat();
  });
  $<HTMLButtonElement>("side-new-chat").addEventListener("click", () => {
    if (streaming) return;
    newChat();
  });

  document.addEventListener("click", (e) => {
    const target = e.target as Node;
    const modelMenu = $<HTMLElement>("model-menu");
    const assistantMenu = $<HTMLElement>("assistant-menu");
    if (!modelMenu.contains(target) && !$<HTMLElement>("composer-model").contains(target)) closeModelMenu();
    if (!assistantMenu.contains(target) && !$<HTMLElement>("composer-assistant").contains(target)) closeAssistantMenu();
  });

  renderToolsToggle();
  setSendEnabled(true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
