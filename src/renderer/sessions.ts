/**
 * Renderer-side session store.
 *
 * Persists `ChatSession[]` in localStorage (single key, JSON array) and
 * tracks the active session id. Emits `change` whenever the list mutates
 * and `active-changed` when the active id changes so the sidebar and the
 * chat thread can react without polling.
 *
 * No server dependency — purely client-side. The store is framework-agnostic
 * and intentionally headless: callers decide how to render.
 *
 * ```ts
 * import { sessionStore } from "./sessions.ts";
 * sessionStore.create("Hello world", [{ role: "user", content: "Hello" }]);
 * const { pinned, recent } = sessionStore.grouped();
 * ```
 */

import type { ChatMessage } from "../shared/chat.ts";
import {
  type ChatSession,
  deriveTitle,
  generateSessionId,
  groupSessions,
  sortSessions,
  validateSession,
} from "../shared/sessions.ts";

export type { ChatSession } from "../shared/sessions.ts";

export const SESSIONS_KEY = "hideout.sessions";
export const ACTIVE_SESSION_KEY = "hideout.activeSessionId";

type ChangeListener = () => void;
type ActiveListener = (id: string | null) => void;

class SessionStore {
  private sessions: Map<string, ChatSession> = new Map();
  private activeId: string | null = null;
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly activeListeners = new Set<ActiveListener>();
  private searchQuery = "";

  constructor() {
    this.load();
    // React to external tab writes (storage event) — keep multi-window in sync.
    try {
      window.addEventListener("storage", (e) => {
        if (e.key === SESSIONS_KEY || e.key === ACTIVE_SESSION_KEY) {
          this.load();
          this.emitChange();
          this.emitActive();
        }
      });
    } catch {
      // No window (tests) — ignore.
    }
  }

  // — persistence ——————————————————————————————————————————————

  private load(): void {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          this.sessions.clear();
          for (const item of parsed) {
            if (validateSession(item) === null) {
              const s = item as ChatSession;
              this.sessions.set(s.id, s);
            }
          }
        }
      }
    } catch {
      // corrupt JSON — start fresh, don't throw
      this.sessions.clear();
    }
    try {
      const active = localStorage.getItem(ACTIVE_SESSION_KEY);
      this.activeId = active && this.sessions.has(active) ? active : null;
    } catch {
      this.activeId = null;
    }
  }

  private persist(): void {
    try {
      const arr = [...this.sessions.values()].sort(sortSessions);
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(arr));
    } catch {
      // quota exceeded or no storage — best effort
    }
    try {
      if (this.activeId) localStorage.setItem(ACTIVE_SESSION_KEY, this.activeId);
      else localStorage.removeItem(ACTIVE_SESSION_KEY);
    } catch {}
  }

  // — events ———————————————————————————————————————————————————

  onChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onActiveChanged(fn: ActiveListener): () => void {
    this.activeListeners.add(fn);
    return () => this.activeListeners.delete(fn);
  }

  private emitChange(): void {
    for (const fn of this.changeListeners) fn();
  }

  private emitActive(): void {
    for (const fn of this.activeListeners) fn(this.activeId);
  }

  // — search filter ————————————————————————————————————————————

  setSearch(query: string): void {
    this.searchQuery = query.trim().toLowerCase();
    this.emitChange();
  }

  getSearch(): string {
    return this.searchQuery;
  }

  private matchesSearch(s: ChatSession): boolean {
    if (!this.searchQuery) return true;
    const q = this.searchQuery;
    if (s.title.toLowerCase().includes(q)) return true;
    // Also match preview / last message.
    const last = s.messages[s.messages.length - 1]?.content.toLowerCase() ?? "";
    if (last.includes(q)) return true;
    return false;
  }

  // — CRUD —————————————————————————————————————————————————————

  list(): ChatSession[] {
    const all = [...this.sessions.values()].filter((s) => this.matchesSearch(s)).sort(sortSessions);
    return all;
  }

  /** Groups current (filtered) list into pinned / recent. */
  grouped(): { pinned: ChatSession[]; recent: ChatSession[] } {
    return groupSessions(this.list());
  }

  /** Unfiltered counts for empty-state text. */
  counts(): { total: number; pinned: number; recent: number } {
    const all = [...this.sessions.values()];
    return {
      total: all.length,
      pinned: all.filter((s) => s.pinned).length,
      recent: all.filter((s) => !s.pinned).length,
    };
  }

  get(id: string): ChatSession | null {
    return this.sessions.get(id) ?? null;
  }

  getActive(): ChatSession | null {
    return this.activeId ? (this.sessions.get(this.activeId) ?? null) : null;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  setActive(id: string | null): void {
    if (id !== null && !this.sessions.has(id)) return;
    this.activeId = id;
    this.persist();
    this.emitActive();
    this.emitChange(); // active row highlights
  }

  create(title?: string, messages: ChatMessage[] = [], opts: { pinned?: boolean } = {}): ChatSession {
    const now = Date.now();
    const derived = title?.trim() || deriveTitle(messages);
    const session: ChatSession = {
      id: generateSessionId(),
      title: derived || "New chat",
      messages: messages.map((m) => ({ ...m })),
      pinned: opts.pinned ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.activeId = session.id;
    this.persist();
    this.emitChange();
    this.emitActive();
    return session;
  }

  /** Ensure a session exists for the current turn; if none active, create one. */
  ensureActive(titleHint?: string): ChatSession {
    const active = this.getActive();
    if (active) return active;
    return this.create(titleHint);
  }

  update(id: string, patch: Partial<Pick<ChatSession, "title" | "pinned" | "messages">>): ChatSession | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    let changed = false;
    if (patch.title !== undefined && patch.title !== s.title) {
      s.title = patch.title.trim() || s.title;
      changed = true;
    }
    if (patch.pinned !== undefined && patch.pinned !== s.pinned) {
      s.pinned = patch.pinned;
      changed = true;
    }
    if (patch.messages !== undefined) {
      s.messages = patch.messages.map((m) => ({ ...m }));
      if (!patch.title && s.title === "New chat" && s.messages.length > 0) {
        s.title = deriveTitle(s.messages);
      }
      changed = true;
    }
    if (changed) {
      s.updatedAt = Date.now();
      this.persist();
      this.emitChange();
    }
    return s;
  }

  /** Append messages to a session (e.g. after a user/assistant turn). */
  appendMessages(id: string, messages: ChatMessage[]): ChatSession | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.messages.push(...messages.map((m) => ({ ...m })));
    // Auto-title on first user message if still default.
    if ((s.title === "New chat" || !s.title.trim()) && s.messages.length > 0) {
      s.title = deriveTitle(s.messages);
    }
    s.updatedAt = Date.now();
    this.persist();
    this.emitChange();
    return s;
  }

  /** Replace entire message list (used when re-syncing from ChatHistory). */
  setMessages(id: string, messages: ChatMessage[]): ChatSession | null {
    return this.update(id, { messages });
  }

  togglePin(id: string): ChatSession | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return this.update(id, { pinned: !s.pinned });
  }

  rename(id: string, title: string): ChatSession | null {
    const trimmed = title.trim();
    if (!trimmed) return null;
    return this.update(id, { title: trimmed });
  }

  delete(id: string): boolean {
    const existed = this.sessions.delete(id);
    if (!existed) return false;
    if (this.activeId === id) {
      // Pick next most recent, or null.
      const next = [...this.sessions.values()].sort(sortSessions)[0]?.id ?? null;
      this.activeId = next;
      this.emitActive();
    }
    this.persist();
    this.emitChange();
    return true;
  }

  clearAll(): void {
    this.sessions.clear();
    this.activeId = null;
    this.persist();
    this.emitChange();
    this.emitActive();
  }

  // — helpers for tests ————————————————————————————————————————

  /** Replace all sessions (tests). */
  _reset(sessions: ChatSession[] = [], activeId: string | null = null): void {
    this.sessions.clear();
    for (const s of sessions) this.sessions.set(s.id, s);
    this.activeId = activeId && this.sessions.has(activeId) ? activeId : null;
    this.searchQuery = "";
    this.persist();
    this.emitChange();
    this.emitActive();
  }
}

export const sessionStore = new SessionStore();
