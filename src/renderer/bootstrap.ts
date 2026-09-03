/**
 * Renderer bootstrap — the app's startup sequence.
 *
 * The window's front end is small and plain: hydrate the Lucide icons
 * declared as `<i data-lucide="…">` in index.html, then wire up the custom
 * title bar, sidebar, theme, composer, settings and chat thread.
 *
 * Ordering is load-bearing: the chat controller registers its
 * `hideout:session-selected` listener before it dispatches the initial event
 * that restores (or creates) the active session, so `wireChat` runs last.
 */
import { hydrateIcons } from './icons.ts'
import { wireNewChatButton, wireModelSelector, wireTitleBar, wireTitleBarSearch } from './titlebar.ts'
import { wireSidebar } from './sidebar.ts'
import { initTheme, wireThemeToggle } from './theme.ts'
import { wireComposer, wireToolsToggle } from './composer.ts'
import { wireSettings } from './settings-mcp.ts'
import { wireCredentials } from './credentials-panel.ts'
import { wirePrivacyPanel } from './privacy-panel.ts'
import { applyStoredEphemeralMode } from './privacy.ts'
import { wireChat } from './chat-controller.ts'

export function bootstrap(): void {
  // Hydrate the Lucide icons declared in index.html. The runtime swaps each
  // placeholder for its SVG, keeping the element's own class and data-*
  // attributes (e.g. `data-theme-icon`, `hidden`).
  hydrateIcons()

  // Privacy mode must apply before any session is created or restored so
  // chats started under "do not save chat history" never reach storage.
  applyStoredEphemeralMode()

  // Custom title bar: dragging, traffic lights, search, new chat, models.
  wireTitleBar()
  wireTitleBarSearch()
  wireNewChatButton()
  wireModelSelector()

  // Sidebar: collapse/expand, resize, collapsible sections, session lists.
  wireSidebar()

  // Theme + composer chrome.
  initTheme()
  wireThemeToggle()
  wireComposer()
  wireToolsToggle()

  // Settings dialog (MCP servers, provider API keys, chat-history privacy).
  wireSettings()
  wireCredentials()
  wirePrivacyPanel()

  // Chat thread last — it dispatches the initial session restore event.
  wireChat()
}
