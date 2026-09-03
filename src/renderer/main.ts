/**
 * The window's front end.
 *
 * Small and plain: hydrate the Lucide icons declared as `<i data-lucide="…">`
 * in index.html, then wire up the custom title bar, sidebar and theme.
 */
import { appWindow, titleBarMetrics } from '@vantail/api'
import { ChevronDown, ChevronLeft, createIcons, MessageCircle, Mic, Moon, PanelLeft, Pencil, Pin, PinOff, Plus, Search, SendHorizontal, Server, Settings, Square, SquarePen, Sun, Trash2, Wrench, X } from 'lucide'
import { ChatHistory, chatStream, getSelectedModel, setSelectedModel, type SelectedModel, type Source } from './chat.ts'
import { sessionStore, type ChatSession } from './sessions.ts'
import { renderMarkdownHighlighted } from './highlight.ts'
import { stripSourcesFromContent } from '../shared/chat.ts'
import { connectMcpServer, createMcpServer, deleteMcpServer, listMcpServers, updateMcpServer } from './mcp.ts'
import { kvToObject, providerLabel, slugifyServerId } from './settings.ts'
import { deleteCredential, listCredentials, setCredential } from './credentials.ts'
import type { CredentialState } from './credentials.ts'
import { validateMcpServerConfig } from '../shared/mcp.ts'
import type { McpServerConfig, McpServerInfo, McpServerStatus, McpTransport } from '../shared/mcp.ts'

// Hydrate the Lucide icons declared as `<i data-lucide="…">` in index.html.
// The runtime swaps each placeholder for its SVG, keeping the element's own
// class and data-* attributes (e.g. `data-theme-icon`, `hidden`).
createIcons({ icons: { ChevronDown, ChevronLeft, MessageCircle, Mic, Moon, PanelLeft, Pencil, Pin, PinOff, Plus, Search, SendHorizontal, Server, Settings, Square, SquarePen, Sun, Trash2, Wrench, X } })

// How far the macOS traffic lights settle below the bar's vertical centre, so
// the sidebar's toggle can sit on the very same row. One source of truth for
// both `setTrafficLightPosition` and the button alignment below.
const TITLEBAR_CONTROLS_PUSH = 18

/**
 * Drive the custom title bar from index.html.
 *
 * `-webkit-app-region: drag` is a Chromium extension and does nothing in
 * WKWebView, so the bar is dragged by telling the runtime to start dragging
 * on pointer-down instead. The platform draws and handles the window buttons
 * (macOS traffic lights); we place them so they stay centred in the bar and
 * keep a comfortable margin off the rounded corner - padded, not clamped.
 */
function wireTitleBar(): void {
  const bar = document.querySelector<HTMLElement>('[data-drag]')
  if (!bar) return

  bar.addEventListener('pointerdown', () => {
    void appWindow?.startDragging()
  })

  const { height = 36, buttonHeight = 14 } = titleBarMetrics() ?? {}
  // Settle the lights a little below centre, and breathe off the leading edge.
  const y = Math.round(height / 2 - buttonHeight / 2 + TITLEBAR_CONTROLS_PUSH)
  void appWindow?.setTrafficLightPosition(20, y)

  // Park every title-bar row (the model selector and the right-side controls)
  // on the very same row as the traffic lights: the header aligns them to its
  // top (items-start), so pushing each down by this margin drops its vertical
  // centre exactly onto the lights'.
  const lightsCenter = height / 2 + TITLEBAR_CONTROLS_PUSH
  for (const row of document.querySelectorAll<HTMLElement>('[data-titlebar-row]')) {
    const top = Math.max(0, Math.round(lightsCenter - row.offsetHeight / 2))
    row.style.marginTop = `${top}px`
  }
}

wireTitleBar()
wireTitleBarSearch()
wireNewChatButton()
wireModelSelector()

/**
 * Expand/collapse the title-bar search. Clicking the (closed) circle slides it
 * open into a search field and focuses it; the field collapses again when it
 * loses focus or Escape is pressed. Stops pointer-down from bubbling so the
 * header's drag-to-move doesn't fight the click.
 */
function wireTitleBarSearch(): void {
  const search = document.querySelector<HTMLElement>('#titlebar-search')
  const field = document.querySelector<HTMLInputElement>('#titlebar-search-field')
  const clear = document.querySelector<HTMLButtonElement>('#titlebar-search-clear')
  if (!search || !field || !clear) return

  search.addEventListener('pointerdown', (event) => event.stopPropagation())
  clear.addEventListener('pointerdown', (event) => event.stopPropagation())

  const updateClear = () => {
    clear.hidden = field.value.length === 0
  }
  const collapse = () => {
    search.classList.remove('expanded')
    search.setAttribute('aria-expanded', 'false')
    clear.hidden = true
  }

  search.addEventListener('click', () => {
    if (search.classList.contains('expanded')) return
    search.classList.add('expanded')
    search.setAttribute('aria-expanded', 'true')
    field.focus()
  })

  field.addEventListener('input', () => {
    updateClear()
    sessionStore.setSearch(field.value)
  })
  clear.addEventListener('click', () => {
    field.value = ''
    updateClear()
    sessionStore.setSearch('')
    field.focus()
  })
  field.addEventListener('focusout', (event) => {
    // Keep the field open when focus moves to the clear button inside the
    // control; only collapse when focus leaves the search entirely.
    if (event.relatedTarget && search.contains(event.relatedTarget as Node)) return
    collapse()
  })
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      field.value = ''
      sessionStore.setSearch('')
      collapse()
      field.blur()
    }
  })
}

/**
 * New chat button — separate circular button to the right of search,
 * same aesthetic (titlebar-group, size-10, rounded-full, border,
 * bg-card/80, backdrop-blur-md, hover/active states).
 * Click actually creates a new chat entry so the sidebar shows it
 * immediately (not just clearing the thread). If an empty draft already
 * exists and is active, reuse it to avoid spamming empty chats.
 */
function wireNewChatButton(): void {
  const btn = document.querySelector<HTMLButtonElement>('#new-chat-button')
  const field = document.querySelector<HTMLTextAreaElement>('#composer-field')
  if (!btn) return

  btn.addEventListener('pointerdown', (event) => event.stopPropagation())

  btn.addEventListener('click', () => {
    const active = sessionStore.getActive()
    // Reuse an existing empty draft to avoid duplicate "New chat" rows
    if (active && active.messages.length === 0) {
      // New chat is always tools-enabled per spec — re-enable if user had disabled this draft
      if (!sessionStore.isToolsEnabled(active.id)) sessionStore.setToolsEnabled(active.id, true)
      window.dispatchEvent(new CustomEvent('hideout:session-selected', { detail: active.id }))
      if (field) {
        field.value = ''
        field.focus()
        field.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return
    }

    // Actually create a new chat — appears instantly in the sidebar
    // (Aktuelle) and becomes the active thread. Chat history/column
    // will be cleared via the hideout:session-selected listener in wireChat.
    // New chats always start with MCP/tools enabled.
    const session = sessionStore.create(undefined, [], { pinned: false, toolsEnabled: true })
    window.dispatchEvent(new CustomEvent('hideout:session-selected', { detail: session.id }))
    if (field) {
      field.value = ''
      field.focus()
      field.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
}

/**
 * The model-selector dropdown in the title bar. Clicking the pill toggles the
 * menu beneath it; clicking anywhere else or pressing Escape closes it.
 * Pointer-down is stopped so the header's drag-to-move doesn't fight the click.
 *
 * When a provider (e.g. Ollama) is connected, usable models are fetched from
 * `GET /api/models` and shown in the dropdown. Selecting a row persists the
 * choice in `localStorage` (via `src/renderer/chat.ts`) and updates the toggle
 * label — the chat library reads that same key when sending.
 */
function wireModelSelector(): void {
  const selector = document.querySelector<HTMLElement>('#model-selector')
  const toggle = document.querySelector<HTMLButtonElement>('#model-selector-toggle')
  const menu = document.querySelector<HTMLElement>('#model-dropdown')
  const chevron = document.querySelector<HTMLElement>('#model-selector-chevron')
  if (!selector || !toggle || !menu || !chevron) return

  // Floating tooltip for truncated model names. It lives on <body> so the
  // menu's overflow clipping can't cut it off, and pairs with the
  // glass look of the dropdown (palette variables flip with the theme).
  // Visibility is driven solely through the `hidden` property below (the
  // attribute kills rendering via the UA stylesheet); no display utility on
  // the class list, or the two would fight and the tooltip would never show.
  const tooltip = document.createElement('div')
  tooltip.className =
    'pointer-events-none fixed z-[60] rounded-md border border-line/70 bg-card/95 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-ink shadow-xl backdrop-blur-md'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.hidden = true
  document.body.appendChild(tooltip)

  // Park the tooltip just past the cursor, flipping it to the other side
  // when it would run off the window's edge.
  const positionTooltip = (x: number, y: number) => {
    tooltip.style.left = `${x + 10}px`
    tooltip.style.top = `${y + 14}px`
    const { width: w, height: h } = tooltip.getBoundingClientRect()
    if (x + 10 + w > window.innerWidth) tooltip.style.left = `${x - w - 10}px`
    if (y + 14 + h > window.innerHeight) tooltip.style.top = `${y - h - 6}px`
  }

  selector.addEventListener('pointerdown', (event) => event.stopPropagation())

  const setOpen = (open: boolean) => {
    toggle.setAttribute('aria-expanded', String(open))
    menu.hidden = !open
    chevron.classList.toggle('rotate-180', open)
    // A closing menu must not leave a stale tooltip on screen.
    if (!open) tooltip.hidden = true
  }

  toggle.addEventListener('click', () => setOpen(Boolean(menu.hidden)))

  // Close when a click lands anywhere outside the selector (the header's
  // drag-to-move pointerdown never reaches here - it was stopped above).
  document.addEventListener('pointerdown', (event) => {
    if (!selector.contains(event.target as Node)) setOpen(false)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false)
  })

  // Keep the toggle label in sync with the persisted selection. The pill's
  // chevron is absolutely positioned, so the label needs its own span that
  // can truncate with an ellipsis without colliding with the chevron.
  const ensureLabelSpan = (): HTMLElement => {
    let label = toggle.querySelector<HTMLElement>('[data-model-label]')
    if (label) return label
    // First call: the toggle currently holds the raw text "Models" and the
    // chevron. Wrap the text so it can truncate independently.
    const raw = toggle.textContent?.trim() ?? "Models"
    // Remove existing text nodes but keep the chevron element
    for (const n of [...toggle.childNodes]) {
      if (n !== chevron && n.nodeType === Node.TEXT_NODE) n.remove()
    }
    // If there was an element that was the label-less text, drop it too
    const span = document.createElement('span')
    span.dataset.modelLabel = 'true'
    span.className = 'min-w-0 flex-1 truncate pr-6 text-center'
    span.textContent = raw
    toggle.insertBefore(span, chevron)
    return span
  }

  const setToggleLabel = (sel: SelectedModel | null) => {
    const span = ensureLabelSpan()
    if (!sel) {
      span.textContent = 'Models'
      toggle.setAttribute('aria-label', 'Select model')
    } else {
      span.textContent = sel.name
      span.title = sel.name
      toggle.setAttribute('aria-label', `Model: ${sel.name}`)
    }
  }

  const updateToggleLabel = (sel: SelectedModel | null) => {
    setToggleLabel(sel)
    // Emit for the chat wiring to react without polling localStorage
    window.dispatchEvent(new CustomEvent('hideout:model-changed', { detail: sel }))
  }

  // Hydrate from the last persisted choice before the model list arrives so
  // the toggle shows the previous selection instantly.
  updateToggleLabel(getSelectedModel())

  type ApiModel = { id: string; name: string; providerId: string; providerName: string }
  const renderModels = (models: ApiModel[]) => {
    menu.replaceChildren()
    if (models.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'px-3 py-2 text-sm text-dim'
      empty.textContent = 'No models available'
      menu.appendChild(empty)
      // If the persisted selection vanished (provider removed), clear it
      const sel = getSelectedModel()
      if (sel && !models.some((m) => m.id === sel.id && m.providerId === sel.providerId)) {
        // Keep the stale label until the next successful fetch? Clear now so
        // the composer can warn "no models available".
      }
      return
    }
    const current = getSelectedModel()
    for (const model of models) {
      const item = document.createElement('button')
      item.type = 'button'
      item.role = 'option'
      item.dataset.modelId = model.id
      item.dataset.providerId = model.providerId
      const isSelected = current?.id === model.id && current?.providerId === model.providerId
      item.setAttribute('aria-selected', String(isSelected))
      // Keep visually aligned with the glass dropdown; hover gives affordance
      // without altering the final design. Selected row gets a subtle accent.
      item.className =
        'flex w-full items-center rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ' +
        (isSelected ? 'bg-accent/15 text-ink' : 'text-ink hover:bg-black/5 dark:hover:bg-white/10')
      // One line per model: long names are truncated with an ellipsis (the
      // dropdown keeps its fixed width), and the full id shows in a floating
      // tooltip on hover when the row actually cut the name off.
      const label = document.createElement('span')
      label.className = 'min-w-0 flex-1 truncate'
      label.textContent = model.name
      item.appendChild(label)
      item.setAttribute('aria-label', `${model.providerName} ${model.name}`)
      item.addEventListener('pointerenter', (event) => {
        // scrollWidth > clientWidth means the ellipsis is showing — a name
        // that fits on its row reads itself and needs no tooltip.
        if (label.scrollWidth <= label.clientWidth) return
        tooltip.textContent = model.name
        tooltip.hidden = false
        positionTooltip(event.clientX, event.clientY)
      })
      item.addEventListener('pointermove', (event) => {
        if (!tooltip.hidden) positionTooltip(event.clientX, event.clientY)
      })
      item.addEventListener('pointerleave', () => {
        tooltip.hidden = true
      })
      item.addEventListener('click', () => {
        const sel: SelectedModel = { providerId: model.providerId, id: model.id, name: model.name }
        setSelectedModel(sel)
        updateToggleLabel(sel)
        // Re-render to show the new selected state
        renderModels(models)
        tooltip.hidden = true
        setOpen(false)
      })
      menu.appendChild(item)
    }
    // If nothing was selected, or the stored id is stale, keep the toggle as
    // "Models" but do not auto-pick — the chat composer will prompt to pick one.
    // If the stored selection is still valid, ensure the label reflects it.
    const fresh = getSelectedModel()
    if (fresh && models.some((m) => m.id === fresh.id && m.providerId === fresh.providerId)) {
      updateToggleLabel(fresh)
    }
  }

  const loadModels = async () => {
    try {
      const res = await fetch('/api/models', { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        renderModels([])
        return
      }
      const data = (await res.json()) as { models?: ApiModel[] } | ApiModel[]
      const models = Array.isArray(data) ? data : (data.models ?? [])
      renderModels(models)
    } catch {
      renderModels([])
    }
  }

  void loadModels()

  // React to external selection changes (e.g. chat wiring clearing it)
  window.addEventListener('hideout:model-changed', (e: Event) => {
    const sel = (e as CustomEvent<SelectedModel | null>).detail
    // Only repaint label — do not re-dispatch or it recurses infinitely
    if (sel) setToggleLabel(sel)
    else setToggleLabel(null)
  })
}

/**
 * Collapse/enlarge the left sidebar and keep its toggle in sync.
 *
 * A single toggle lives in the right-side title-bar pill, which stays visible
 * in both states, so the window controls are always reachable.
 */
function setSidebarCollapsed(collapsed: boolean, animating: boolean = true): void {
  if (!sidebar) return
  if (collapsed) {
    // Hide the toggle the moment collapsing starts, before the width animation
    // squishes it; the width transition then finishes the collapse.
    sidebar.classList.add('collapsing')
    sidebar.classList.add('collapsed')
  } else if (animating) {
    // Keep it hidden while the sidebar grows back; a width transitionend
    // (below) reveals it again.
    sidebar.classList.add('collapsing')
    sidebar.classList.remove('collapsed')
  } else {
    // No animation (e.g. a manual resize drag): reveal straight away.
    sidebar.classList.remove('collapsing')
    sidebar.classList.remove('collapsed')
  }
  for (const toggle of sidebarToggles) {
    toggle.setAttribute('aria-expanded', String(!collapsed))
  }

  // Tell the stylesheet how the bar is laid out: with the sidebar gone, the
  // model selector would slip under the macOS traffic lights, which float
  // over the window's leading edge - CSS slides it right to clear them
  // (body.sidebar-collapsed #model-selector in styles.css).
  document.body.classList.toggle('sidebar-collapsed', collapsed)
}

function wireSidebarToggle(): void {
  if (!sidebar) return
  for (const toggle of sidebarToggles) {
    toggle.addEventListener('click', () => {
      setSidebarCollapsed(!sidebar.classList.contains('collapsed'))
    })
  }
}

// Shared handles used by the toggle and the resize wiring.
const sidebar = document.querySelector<HTMLElement>('#sidebar')
const sidebarToggles = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-sidebar-toggle]'))

if (sidebar) {
  wireSidebarToggle()

  // Reveal the sidebar's toggle once the collapse/expand width animation ends.
  sidebar.addEventListener('transitionend', (event) => {
    if (event.propertyName === 'width') sidebar.classList.remove('collapsing')
  })
}

/**
 * Resize the sidebar by dragging the handle between it and the content.
 *
 * The handle captures the pointer for the whole drag and sets the sidebar
 * width from the cursor's X (the sidebar starts at the window's left edge).
 * Width is clamped so it cannot get too narrow to hold content or push the
 * content pane out entirely.
 */
function wireSidebarResize(): void {
  const handle = document.querySelector<HTMLElement>('#sidebar-resizer')
  if (!sidebar || !handle) return

  const minWidth = 160
  handle.addEventListener('pointerdown', (event) => {
    sidebar.classList.add('dragging')
    setSidebarCollapsed(false, false) // a drag resizes it open, no hiding
    handle.setPointerCapture(event.pointerId)
    event.preventDefault()
  })

  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return
    const maxWidth = Math.max(minWidth, Math.floor(window.innerWidth * 0.5))
    const width = Math.min(maxWidth, Math.max(minWidth, event.clientX))
    sidebar.style.width = `${width}px`
  })

  const endDrag = () => sidebar.classList.remove('dragging')
  handle.addEventListener('pointerup', endDrag)
  handle.addEventListener('pointercancel', endDrag)
}

/**
 * Collapsible sidebar sections — “Angeheftet” (pinned) and “Aktuelle”
 * (recent). Each heading is a <button> with `data-collapse-toggle` that
 * toggles `is-collapsed` on its parent `.sidebar-section`. State persists
 * in localStorage so the user’s choice survives reloads. Respects the
 * existing `hidden` logic in `wireSidebarSessions` (search/empty): the
 * collapse only hides the list, not the whole section when it would be
 * hidden anyway.
 */
function wireSidebarSectionsCollapsible(): void {
  const toggles = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-collapse-toggle]'))
  if (toggles.length === 0) return

  const storageKey = (id: string) => `hideout.sidebar.collapsed.${id}`

  const apply = (btn: HTMLButtonElement, collapsed: boolean) => {
    const section = btn.closest<HTMLElement>('.sidebar-section')
    if (!section) return
    section.classList.toggle('is-collapsed', collapsed)
    btn.setAttribute('aria-expanded', String(!collapsed))
    // Chevron rotation is pure CSS on .is-collapsed; no JS needed there.
  }

  for (const btn of toggles) {
    const id = btn.dataset.collapseToggle ?? ''
    if (!id) continue

    // Restore persisted state
    let collapsed = false
    try {
      collapsed = localStorage.getItem(storageKey(id)) === '1'
    } catch {}
    apply(btn, collapsed)

    btn.addEventListener('click', () => {
      const section = btn.closest<HTMLElement>('.sidebar-section')
      if (!section) return
      const next = !section.classList.contains('is-collapsed')
      apply(btn, next)
      try {
        if (next) localStorage.setItem(storageKey(id), '1')
        else localStorage.removeItem(storageKey(id))
      } catch {}
    })
  }
}

wireSidebarResize()
wireSidebarSectionsCollapsible()
wireSidebarSessions()

/**
 * Sidebar chat sessions — pinned vs normal chats.
 *
 * Renders the left sidebar's two groups from `sessionStore`. Each row shows
 * the title and hover actions to pin/unpin or delete. Clicking a row makes
 * it active and dispatches `hideout:session-selected` so the chat thread can
 * render its messages. The store persists to localStorage and filters via
 * the title-bar search.
 */
function wireSidebarSessions(): void {
  const pinnedList = document.querySelector<HTMLElement>('#pinned-list')
  const chatsList = document.querySelector<HTMLElement>('#chats-list')
  const pinnedSection = document.querySelector<HTMLElement>('#pinned-section')
  const chatsSection = document.querySelector<HTMLElement>('#chats-section')
  const emptyEl = document.querySelector<HTMLElement>('#sidebar-empty')
  const noResultsEl = document.querySelector<HTMLElement>('#sidebar-no-results')
  const pinnedEmpty = document.querySelector<HTMLElement>('#pinned-empty')
  const chatsEmpty = document.querySelector<HTMLElement>('#chats-empty')
  if (!pinnedList || !chatsList || !pinnedSection || !chatsSection) return

  const createRow = (session: ChatSession, isActive: boolean): HTMLElement => {
    const row = document.createElement('div')
    row.className = `session-row group${isActive ? ' active' : ''}`
    row.dataset.sessionId = session.id
    row.tabIndex = 0
    row.setAttribute('role', 'button')
    row.setAttribute('aria-label', session.title)
    row.setAttribute('aria-selected', String(isActive))

    // Screenshot: pinned rows have a hollow bubble (message-circle) at the
    // leading edge; recent ("Aktuelle") rows are plain text with no icon.
    // We add the icon conditionally so recent rows align flush left.
    if (session.pinned) {
      const icon = document.createElement('i')
      icon.className = 'session-icon size-[18px] shrink-0'
      icon.setAttribute('data-lucide', 'message-circle')
      row.appendChild(icon)
    }

    const textCol = document.createElement('div')
    textCol.className = 'min-w-0 flex-1'
    const titleEl = document.createElement('div')
    titleEl.className = 'session-title'
    titleEl.textContent = session.title
    titleEl.title = session.title
    textCol.appendChild(titleEl)

    const actions = document.createElement('div')
    actions.className = 'session-actions'

    const pinBtn = document.createElement('button')
    pinBtn.type = 'button'
    pinBtn.className = `session-action${session.pinned ? ' active-pin' : ''}`
    pinBtn.setAttribute('aria-label', session.pinned ? 'Unpin chat' : 'Pin chat')
    pinBtn.dataset.pinToggle = session.id
    const pinIcon = document.createElement('i')
    pinIcon.className = 'size-3.5'
    pinIcon.setAttribute('data-lucide', session.pinned ? 'pin-off' : 'pin')
    pinBtn.appendChild(pinIcon)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'session-action'
    deleteBtn.setAttribute('aria-label', 'Delete chat')
    deleteBtn.dataset.delete = session.id
    const trashIcon = document.createElement('i')
    trashIcon.className = 'size-3.5'
    trashIcon.setAttribute('data-lucide', 'trash-2')
    deleteBtn.appendChild(trashIcon)

    // Double-click title to rename inline
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      startRename(session, titleEl)
    })

    actions.appendChild(pinBtn)
    actions.appendChild(deleteBtn)

    row.appendChild(textCol)
    row.appendChild(actions)

    // Click row → select session
    row.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-pin-toggle]') || target.closest('[data-delete]')) return
      sessionStore.setActive(session.id)
      window.dispatchEvent(new CustomEvent('hideout:session-selected', { detail: session.id }))
    })
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        sessionStore.setActive(session.id)
        window.dispatchEvent(new CustomEvent('hideout:session-selected', { detail: session.id }))
      }
    })
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      sessionStore.togglePin(session.id)
    })
    pinBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
    deleteBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // Remove immediately — `confirm()` is unreliable in WKWebView/Vantail
      // and was preventing deletion (always returned false). No confirmation
      // dialog; delete is instant and handled via the store.
      const wasActive = sessionStore.getActiveId() === session.id
      const didDelete = sessionStore.delete(session.id)
      if (!didDelete) return
      if (wasActive) {
        const next = sessionStore.getActiveId()
        window.dispatchEvent(new CustomEvent('hideout:session-selected', { detail: next }))
      }
    })

    return row
  }

  const startRename = (session: ChatSession, titleEl: HTMLElement) => {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = session.title
    input.className =
      'w-full rounded-md border border-accent bg-card px-1.5 py-0.5 text-sm font-semibold text-ink outline-none'
    input.setAttribute('aria-label', 'Rename chat')
    const parent = titleEl.parentElement
    if (!parent) return
    titleEl.replaceWith(input)
    input.focus()
    input.select()
    const commit = () => {
      const next = input.value.trim()
      if (next && next !== session.title) sessionStore.rename(session.id, next)
      else {
        // restore without mutation; store will re-render anyway
        input.replaceWith(titleEl)
      }
    }
    const cancel = () => input.replaceWith(titleEl)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
      if (e.key === 'Escape') cancel()
    })
    input.addEventListener('blur', commit)
  }

  const render = () => {
    const activeId = sessionStore.getActiveId()
    const { pinned, recent } = sessionStore.grouped()
    const counts = sessionStore.counts()
    const hasSearch = !!sessionStore.getSearch()

    pinnedList.replaceChildren()
    chatsList.replaceChildren()

    for (const s of pinned) pinnedList.appendChild(createRow(s, s.id === activeId))
    for (const s of recent) chatsList.appendChild(createRow(s, s.id === activeId))

    // Hydrate icons for new rows — recent rows have no bubble icon; pinned
    // rows use MessageCircle as in the screenshot.
    createIcons({ icons: { MessageCircle, Pin, PinOff, Trash2 } })

    // Section visibility
    const totalFiltered = pinned.length + recent.length
    if (counts.total === 0) {
      pinnedSection.hidden = true
      chatsSection.hidden = true
      if (emptyEl) emptyEl.hidden = false
      if (noResultsEl) noResultsEl.hidden = true
    } else if (hasSearch && totalFiltered === 0) {
      pinnedSection.hidden = true
      chatsSection.hidden = true
      if (emptyEl) emptyEl.hidden = true
      if (noResultsEl) noResultsEl.hidden = false
    } else {
      if (emptyEl) emptyEl.hidden = true
      if (noResultsEl) noResultsEl.hidden = true
      pinnedSection.hidden = false
      chatsSection.hidden = false
      if (pinnedEmpty) pinnedEmpty.hidden = pinned.length !== 0 || hasSearch
      if (chatsEmpty) chatsEmpty.hidden = recent.length !== 0 || hasSearch
      // When no pinned at all (and not searching), hide the whole pinned header to save space
      if (!hasSearch && counts.pinned === 0) {
        pinnedSection.hidden = true
      }
    }
  }

  sessionStore.onChange(render)
  sessionStore.onActiveChanged(() => render())
  render()
}

/**
 * Dark/light theme.
 *
 * A `.dark` class on <html> flips the palette CSS variables (see styles.css),
 * so every themed utility restyles at once. The choice is remembered in
 * localStorage and falls back to the system preference. Each
 * `[data-theme-toggle]` button shows the mode it would switch to (a moon in
 * light, a sun in dark) and keeps every copy of itself in sync.
 */
const THEME_KEY = 'hideout.theme'

function themeIsDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  try {
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
  } catch {
    // No storage (e.g. a locked-down webview): the theme still applies for
    // this session, it just will not be remembered.
  }
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode'
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    button.setAttribute('aria-label', label)
  }
  const activeIcon = dark ? 'dark' : 'light'
  for (const icon of document.querySelectorAll('[data-theme-icon]')) {
    if (icon.getAttribute('data-theme-icon') === activeIcon) {
      icon.removeAttribute('hidden')
    } else {
      icon.setAttribute('hidden', '')
    }
  }
}

function initTheme(): void {
  let dark: boolean
  try {
    const stored = localStorage.getItem(THEME_KEY)
    dark = stored === 'dark' || (stored === null && window.matchMedia('(prefers-color-scheme: dark)').matches)
  } catch {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  applyTheme(dark)
}

function wireThemeToggle(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    button.addEventListener('click', () => applyTheme(!themeIsDark()))
  }
}

/**
 * Auto-grow the chat composer's textarea with its content.
 *
 * The field is a textarea whose height tracks its scrollHeight on every
 * input, so the pill grows line by line instead of clipping long messages.
 * Growth stops at exactly four lines of text (or 40% of the window height
 * on smaller windows); past it, the textarea scrolls instead of growing, so
 * the bar stays compact and the line being typed is never cut off.
 */
function wireComposer(): void {
  const field = document.querySelector<HTMLTextAreaElement>('#composer-field')
  if (!field) return

  // Whether the caret is at the end of the text (the default). While true,
  // the view stays pinned to the bottom once the text outgrows the bar, so
  // the line being typed is always fully visible; scrolling up to re-read
  // older text un-pins it and is respected until the next keystroke.
  let pinnedToBottom = true

  const resize = () => {
    const maxHeight = Math.min(108, Math.round(window.innerHeight * 0.4))
    // Reset first so the height can shrink again when text is removed.
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, maxHeight)}px`
    // Keep the current (bottom) line in view when the text overflows the
    // cap; without this, typing continues below the fold, out of sight.
    if (pinnedToBottom && field.scrollHeight > maxHeight) {
      field.scrollTop = field.scrollHeight
    }
  }

  field.addEventListener('scroll', () => {
    if (field.scrollHeight > field.clientHeight) {
      pinnedToBottom = field.scrollTop + field.clientHeight >= field.scrollHeight - 1
    }
  })
  field.addEventListener('input', resize)
  window.addEventListener('resize', resize)
  resize()
}

/**
 * Wrench / tools toggle — per-chat MCP enable/disable.
 *
 * The button with `#tools-toggle` (wrench icon) controls whether MCP/tools
 * are exposed for the current chat. State lives per-session in `sessionStore`
 * (`toolsEnabled`, defaults to true). New chats are always created enabled;
 * the user can disable it for the current chat if tools are not needed.
 *
 * Visual: `aria-pressed` + `tools-enabled` / `tools-disabled` + accent bg
 * when enabled, dimmed when disabled. Updates on session change and on click.
 */
function wireToolsToggle(): void {
  const btn = document.querySelector<HTMLButtonElement>('#tools-toggle')
  if (!btn) return

  const updateUI = (): void => {
    const id = sessionStore.getActiveId()
    const enabled = id ? sessionStore.isToolsEnabled(id) : true
    btn.setAttribute('aria-pressed', String(enabled))
    btn.setAttribute('aria-label', enabled ? 'Tools enabled — click to disable' : 'Tools disabled — click to enable')
    btn.title = enabled ? 'MCP tools enabled — click to disable for this chat' : 'MCP tools disabled — click to enable for this chat'
    btn.classList.toggle('tools-enabled', enabled)
    btn.classList.toggle('tools-disabled', !enabled)
    // Accent highlight when enabled, muted when disabled — mirrors selected row feel
    if (enabled) {
      btn.classList.add('bg-accent/15', 'text-ink')
      btn.classList.remove('opacity-60')
    } else {
      btn.classList.remove('bg-accent/15', 'text-ink')
      btn.classList.add('opacity-60')
    }
  }

  btn.addEventListener('click', () => {
    const active = sessionStore.getActive()
    if (!active) {
      // No session yet — create an enabled one then toggle off, so a click
      // from empty state actually disables this new chat as the user intended.
      const s = sessionStore.create(undefined, [], { pinned: false, toolsEnabled: true })
      sessionStore.setToolsEnabled(s.id, false)
      window.dispatchEvent(new CustomEvent('hideout:session-selected', { detail: s.id }))
      return
    }
    sessionStore.toggleTools(active.id)
  })

  // Keep UI in sync with store + session switches
  sessionStore.onChange(updateUI)
  sessionStore.onActiveChanged(updateUI)
  window.addEventListener('hideout:session-selected', updateUI)
  updateUI()
}

/**
 * Settings modal — MCP server management.
 *
 * The gear button in the title bar opens a centered glass dialog (shell in
 * index.html) listing the configured MCP servers with their connection
 * status. User-configured servers can be added, edited and deleted; the
 * code-owned built-in (Exa) is read-only. The forms mirror the shared
 * contract in src/shared/mcp.ts (STDIO → command/args/env, HTTP/SSE →
 * url/headers/timeout) and reuse the renderer helpers in src/renderer/mcp.ts.
 * After a save the server is reconnected so the list reflects a real status
 * instead of a stale "disconnected".
 */
function wireSettings(): void {
  const button = document.querySelector<HTMLButtonElement>('#settings-button')
  const backdrop = document.querySelector<HTMLElement>('#settings-backdrop')
  const modal = document.querySelector<HTMLElement>('#settings-modal')
  const closeBtn = document.querySelector<HTMLButtonElement>('#settings-close')
  const listView = document.querySelector<HTMLElement>('#mcp-view')
  const listEl = document.querySelector<HTMLElement>('#mcp-list')
  const loadingEl = document.querySelector<HTMLElement>('#mcp-loading')
  const loadErrorEl = document.querySelector<HTMLElement>('#mcp-load-error')
  const retryBtn = document.querySelector<HTMLButtonElement>('#mcp-retry-button')
  const emptyEl = document.querySelector<HTMLElement>('#mcp-empty')
  const listErrorEl = document.querySelector<HTMLElement>('#mcp-list-error')
  const addButton = document.querySelector<HTMLButtonElement>('#mcp-add-button')
  const formView = document.querySelector<HTMLElement>('#mcp-form-view')
  const form = document.querySelector<HTMLFormElement>('#mcp-form')
  const formBack = document.querySelector<HTMLButtonElement>('#mcp-form-back')
  const formTitle = document.querySelector<HTMLElement>('#mcp-form-title')
  const formErrorEl = document.querySelector<HTMLElement>('#mcp-form-error')
  const submitBtn = document.querySelector<HTMLButtonElement>('#mcp-form-submit')
  const submitLabel = document.querySelector<HTMLElement>('#mcp-form-submit-label')
  const fieldsEl = document.querySelector<HTMLElement>('#mcp-form-fields')
  if (
    !button || !backdrop || !modal || !closeBtn || !listView || !listEl ||
    !loadingEl || !loadErrorEl || !retryBtn || !emptyEl || !listErrorEl ||
    !addButton || !formView || !form || !formBack || !formTitle ||
    !formErrorEl || !submitBtn || !submitLabel || !fieldsEl
  ) return

  // Re-hydrate Lucide icons added to the DOM at runtime (the startup call at
  // the top of this file only covers the static markup in index.html).
  const hydrateIcons = () => createIcons({ icons: { ChevronLeft, Pencil, Plus, Trash2, X } })

  // ── Open / close ──────────────────────────────────────────────────────
  let lastFocused: HTMLElement | null = null

  button.addEventListener('pointerdown', (event) => event.stopPropagation())
  button.addEventListener('click', () => {
    if (backdrop.hidden) openSettings()
  })
  closeBtn.addEventListener('click', () => closeSettings())
  // Clicking the backdrop (not the dialog) dismisses.
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) closeSettings()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !backdrop.hidden) closeSettings()
  })
  // Light focus trap so Tab cycles inside the dialog while it is open.
  modal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    const focusables = Array.from(
      modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hidden && el.getClientRects().length > 0)
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  // The wireSettings helpers are `const` arrows (not hoisted declarations)
  // so TypeScript keeps the narrowing from the null guard above inside them.
  const openSettings = (): void => {
    lastFocused = document.activeElement as HTMLElement | null
    backdrop.hidden = false
    button.setAttribute('aria-expanded', 'true')
    closeBtn.focus()
    showListView()
    void refresh()
    window.dispatchEvent(new CustomEvent('hideout:settings-opened'))
  }

  const closeSettings = (): void => {
    if (backdrop.hidden) return
    backdrop.hidden = true
    button.setAttribute('aria-expanded', 'false')
    lastFocused?.focus()
  }

  // ── Server list ───────────────────────────────────────────────────────
  let servers: McpServerInfo[] = []

  const setListState = (state: 'loading' | 'error' | 'empty' | 'list') => {
    loadingEl.hidden = state !== 'loading'
    loadErrorEl.hidden = state !== 'error'
    emptyEl.hidden = state !== 'empty'
    listEl.hidden = state !== 'list'
  }

  const showListError = (message: string) => {
    listErrorEl.textContent = message
    listErrorEl.hidden = false
  }

  const refresh = async (): Promise<void> => {
    setListState('loading')
    listErrorEl.hidden = true
    try {
      servers = await listMcpServers()
      if (servers.length === 0) {
        setListState('empty')
      } else {
        renderList()
        setListState('list')
      }
    } catch {
      setListState('error')
    }
  }

  const STATUS_LABELS: Record<McpServerStatus, string> = {
    connected: 'Connected',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
    error: 'Error',
  }

  const renderList = (): void => {
    listEl.replaceChildren(...servers.map(renderServerRow))
    hydrateIcons()
  }

  const renderServerRow = (info: McpServerInfo): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'mcp-server-row'
    row.dataset.serverId = info.id

    const textCol = document.createElement('div')
    textCol.className = 'flex min-w-0 flex-1 flex-col gap-1'

    const titleRow = document.createElement('div')
    titleRow.className = 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'
    const name = document.createElement('span')
    name.className = 'truncate text-sm font-medium text-ink'
    name.textContent = info.name
    name.title = info.name
    titleRow.appendChild(name)
    const transportBadge = document.createElement('span')
    transportBadge.className = 'mcp-transport-badge'
    transportBadge.textContent = info.transport
    titleRow.appendChild(transportBadge)
    if (info.builtIn) {
      const builtInBadge = document.createElement('span')
      builtInBadge.className = 'mcp-builtin-badge'
      builtInBadge.textContent = 'Built-in'
      titleRow.appendChild(builtInBadge)
    }
    const statusBadge = document.createElement('span')
    statusBadge.className = `mcp-status-badge is-${info.status}`
    const dot = document.createElement('span')
    dot.className = 'mcp-status-dot'
    dot.setAttribute('aria-hidden', 'true')
    const statusText = document.createElement('span')
    statusText.textContent = STATUS_LABELS[info.status]
    statusBadge.append(dot, statusText)
    titleRow.appendChild(statusBadge)
    textCol.appendChild(titleRow)

    if (info.description) {
      const desc = document.createElement('p')
      desc.className = 'truncate text-xs text-dim'
      desc.textContent = info.description
      desc.title = info.description
      textCol.appendChild(desc)
    }
    if (info.status === 'error' && info.error) {
      const err = document.createElement('p')
      err.className = 'truncate text-xs text-red-600 dark:text-red-400'
      err.textContent = info.error
      err.title = info.error
      textCol.appendChild(err)
    }
    row.appendChild(textCol)

    if (!info.builtIn) {
      const actions = document.createElement('div')
      actions.className = 'mcp-row-actions'
      actions.appendChild(makeActionButton('pencil', `Edit ${info.name}`, () => startEdit(info)))
      actions.appendChild(makeActionButton('trash-2', `Delete ${info.name}`, () => void removeServer(info)))
      row.appendChild(actions)
    }
    return row
  }

  const makeActionButton = (iconName: string, ariaLabel: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'mcp-action'
    b.setAttribute('aria-label', ariaLabel)
    const icon = document.createElement('i')
    icon.className = 'size-3.5'
    icon.setAttribute('data-lucide', iconName)
    b.appendChild(icon)
    b.addEventListener('click', onClick)
    return b
  }

  const removeServer = async (info: McpServerInfo): Promise<void> => {
    // Instant deletion, matching the sidebar chat rows — confirm() is
    // unreliable in WKWebView/Vantail.
    try {
      await deleteMcpServer(info.id)
      listErrorEl.hidden = true
      void refresh()
    } catch (e) {
      showListError(e instanceof Error ? e.message : String(e))
    }
  }

  retryBtn.addEventListener('click', () => void refresh())
  addButton.addEventListener('click', () => showForm('Add MCP server'))
  formBack.addEventListener('click', () => showListView())

  // ── Add / edit form ───────────────────────────────────────────────────
  const fieldInputCls =
    'w-full rounded-lg border border-line/70 bg-card/80 px-2.5 py-1.5 text-sm text-ink caret-ink outline-none transition-colors duration-150 placeholder:text-dim/60 focus:border-accent/70'
  const rowInputCls =
    'min-w-0 flex-1 rounded-lg border border-line/70 bg-card/80 px-2.5 py-1.5 text-sm text-ink caret-ink outline-none transition-colors duration-150 placeholder:text-dim/60 focus:border-accent/70'

  const makeTextInput = (opts: { placeholder?: string; type?: string; cls?: string } = {}): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = opts.type ?? 'text'
    input.className = opts.cls ?? fieldInputCls
    if (opts.placeholder) input.placeholder = opts.placeholder
    return input
  }

  /** Label-wrapped field for single controls. */
  const makeField = (labelText: string, control: HTMLElement, hint?: string): HTMLElement => {
    const wrap = document.createElement('label')
    wrap.className = 'block min-w-0'
    const label = document.createElement('span')
    label.className = 'mb-1 block text-xs font-medium text-dim'
    label.textContent = labelText
    wrap.append(label, control)
    if (hint) {
      const p = document.createElement('p')
      p.className = 'mt-1 text-[11px] leading-relaxed text-dim/80'
      p.textContent = hint
      wrap.appendChild(p)
    }
    return wrap
  }

  /** Group with its own heading, for fields that hold lists of rows. */
  const makeGroup = (labelText: string, content: HTMLElement, hint?: string): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'min-w-0'
    const label = document.createElement('span')
    label.className = 'mb-1 block text-xs font-medium text-dim'
    label.textContent = labelText
    wrap.append(label, content)
    if (hint) {
      const p = document.createElement('p')
      p.className = 'mt-1 text-[11px] leading-relaxed text-dim/80'
      p.textContent = hint
      wrap.appendChild(p)
    }
    return wrap
  }

  const makeAddRowButton = (labelText: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className =
      'inline-flex h-7 items-center gap-1 self-start rounded-full border border-line/70 bg-card/80 px-2.5 text-[11px] font-medium text-dim transition-colors duration-150 hover:bg-black/10 hover:text-ink active:bg-black/15 dark:hover:bg-white/10 dark:hover:text-ink dark:active:bg-white/15'
    const icon = document.createElement('i')
    icon.className = 'size-3'
    icon.setAttribute('data-lucide', 'plus')
    b.appendChild(icon)
    const span = document.createElement('span')
    span.textContent = labelText
    b.appendChild(span)
    b.addEventListener('click', onClick)
    return b
  }

  const makeRemoveButton = (ariaLabel: string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className =
      'grid size-6 shrink-0 place-items-center rounded-full text-dim transition-colors duration-150 hover:bg-black/10 hover:text-ink active:bg-black/15 dark:hover:bg-white/10 dark:hover:text-ink dark:active:bg-white/15'
    b.setAttribute('aria-label', ariaLabel)
    const icon = document.createElement('i')
    icon.className = 'size-3'
    icon.setAttribute('data-lucide', 'x')
    b.appendChild(icon)
    return b
  }

  // Shared fields: name, id, description, enabled.
  const nameInput = makeTextInput({ placeholder: 'e.g. Filesystem server' })
  const idInput = makeTextInput({ placeholder: 'e.g. filesystem' })
  const descriptionInput = makeTextInput({ placeholder: 'Optional description' })

  const enabledCheckbox = document.createElement('input')
  enabledCheckbox.type = 'checkbox'
  enabledCheckbox.className = 'sr-only'
  enabledCheckbox.checked = true
  const enabledSwitch = document.createElement('span')
  enabledSwitch.className = 'switch'
  const enabledText = document.createElement('span')
  enabledText.className = 'text-sm font-medium text-ink'
  enabledText.textContent = 'Enabled'
  const enabledControl = document.createElement('label')
  enabledControl.className = 'flex cursor-pointer select-none items-center gap-2.5'
  enabledControl.append(enabledCheckbox, enabledSwitch, enabledText)
  const enabledRow = document.createElement('div')
  enabledRow.className = 'flex items-center justify-between gap-3'
  const enabledLabel = document.createElement('span')
  enabledLabel.className = 'text-xs font-medium text-dim'
  enabledLabel.textContent = 'Expose this server’s tools to the chat'
  enabledRow.append(enabledLabel, enabledControl)

  // Suggest the id from the name until the user edits the id themselves.
  let idTouched = false
  nameInput.addEventListener('input', () => {
    if (!idTouched) idInput.value = slugifyServerId(nameInput.value)
  })
  idInput.addEventListener('input', () => {
    idTouched = true
  })

  // Transport selector (segmented control in the app's pill language).
  const TRANSPORTS: Array<{ id: McpTransport; label: string }> = [
    { id: 'stdio', label: 'STDIO' },
    { id: 'http', label: 'HTTP' },
    { id: 'sse', label: 'SSE' },
  ]
  let transport: McpTransport = 'http'
  let editingId: string | null = null
  const transportSegments: HTMLButtonElement[] = []
  const transportSelector = document.createElement('div')
  transportSelector.className = 'inline-flex items-center gap-1 rounded-full border border-line/70 bg-card/80 p-1'
  for (const t of TRANSPORTS) {
    const seg = document.createElement('button')
    seg.type = 'button'
    seg.dataset.transport = t.id
    seg.className = 'rounded-full px-3.5 py-1 text-xs font-medium transition-colors duration-150'
    seg.textContent = t.label
    seg.addEventListener('click', () => {
      transport = t.id
      renderTransport()
    })
    transportSegments.push(seg)
    transportSelector.appendChild(seg)
  }

  // STDIO fields: command, args, env, cwd.
  const commandInput = makeTextInput({ placeholder: 'e.g. npx' })
  const argsList = document.createElement('div')
  argsList.className = 'flex flex-col gap-2'
  const argsRows: HTMLInputElement[] = []
  const addArgRow = (value = '') => {
    const wrap = document.createElement('div')
    wrap.className = 'flex items-center gap-2'
    const input = makeTextInput({
      placeholder: 'e.g. -y @modelcontextprotocol/server-filesystem',
      cls: rowInputCls,
    })
    input.value = value
    const remove = makeRemoveButton('Remove argument')
    remove.addEventListener('click', () => {
      wrap.remove()
      const idx = argsRows.indexOf(input)
      if (idx >= 0) argsRows.splice(idx, 1)
    })
    wrap.append(input, remove)
    argsList.appendChild(wrap)
    argsRows.push(input)
    hydrateIcons()
  }
  const argsBox = document.createElement('div')
  argsBox.className = 'flex flex-col gap-2'
  argsBox.append(argsList, makeAddRowButton('Add argument', () => addArgRow()))

  const cwdInput = makeTextInput({ placeholder: 'e.g. /Users/me/project' })

  type KvRow = { keyInput: HTMLInputElement; valueInput: HTMLInputElement; el: HTMLElement }
  const makeKvRow = (
    rows: KvRow[],
    container: HTMLElement,
    keyPh: string,
    valuePh: string,
  ): KvRow => {
    const el = document.createElement('div')
    el.className = 'flex items-center gap-2'
    const keyInput = makeTextInput({ placeholder: keyPh, cls: rowInputCls })
    const valueInput = makeTextInput({ placeholder: valuePh, cls: rowInputCls })
    const remove = makeRemoveButton('Remove row')
    const row: KvRow = { keyInput, valueInput, el }
    remove.addEventListener('click', () => {
      el.remove()
      const idx = rows.indexOf(row)
      if (idx >= 0) rows.splice(idx, 1)
    })
    el.append(keyInput, valueInput, remove)
    container.appendChild(el)
    rows.push(row)
    hydrateIcons()
    return row
  }

  const envList = document.createElement('div')
  envList.className = 'flex flex-col gap-2'
  const envRows: KvRow[] = []
  const envBox = document.createElement('div')
  envBox.className = 'flex flex-col gap-2'
  envBox.append(envList, makeAddRowButton('Add variable', () => makeKvRow(envRows, envList, 'e.g. FOO', 'e.g. bar')))

  const stdioGroup = document.createElement('div')
  stdioGroup.className = 'flex flex-col gap-4'
  stdioGroup.append(
    makeField('Command', commandInput, 'Executable that starts the server — e.g. npx, uvx, node.'),
    makeGroup('Arguments', argsBox, 'One argument per row, in order.'),
    makeGroup('Environment variables', envBox, 'Optional variables injected into the process.'),
    makeField('Working directory', cwdInput, 'Optional directory the command runs in.'),
  )

  // HTTP/SSE fields: url, headers, timeout.
  const urlInput = makeTextInput({ placeholder: 'https://mcp.example.com/mcp' })
  const headerList = document.createElement('div')
  headerList.className = 'flex flex-col gap-2'
  const headerRows: KvRow[] = []
  const headersBox = document.createElement('div')
  headersBox.className = 'flex flex-col gap-2'
  headersBox.append(headerList, makeAddRowButton('Add header', () => makeKvRow(headerRows, headerList, 'e.g. Authorization', 'e.g. Bearer …')))
  const timeoutInput = makeTextInput({ type: 'number', placeholder: '30' })
  timeoutInput.min = '1'
  timeoutInput.max = '600'

  const httpGroup = document.createElement('div')
  httpGroup.className = 'flex flex-col gap-4'
  httpGroup.append(
    makeField('Endpoint URL', urlInput, 'Remote Streamable HTTP (or legacy SSE) endpoint.'),
    makeGroup('Headers', headersBox, 'Optional request headers, e.g. Authorization.'),
    makeField('Timeout (seconds)', timeoutInput, 'Defaults to 30.'),
  )

  fieldsEl.append(
    makeField('Name', nameInput),
    makeField('ID', idInput, 'Lowercase letters, numbers, - or _ (2–31 chars).'),
    makeField('Description', descriptionInput),
    enabledRow,
    makeGroup('Transport', transportSelector),
    stdioGroup,
    httpGroup,
  )
  hydrateIcons()

  const renderTransport = (): void => {
    for (const seg of transportSegments) {
      const active = seg.dataset.transport === transport
      seg.classList.toggle('bg-accent/15', active)
      seg.classList.toggle('text-ink', active)
      seg.classList.toggle('text-dim', !active)
      seg.classList.toggle('hover:text-ink', !active)
      seg.setAttribute('aria-pressed', String(active))
    }
    stdioGroup.hidden = transport !== 'stdio'
    httpGroup.hidden = transport === 'stdio'
  }

  const clearRows = (container: HTMLElement, rows: Array<HTMLInputElement | KvRow>): void => {
    rows.length = 0
    container.replaceChildren()
  }

  const showForm = (title: string, prefill?: McpServerInfo): void => {
    listView.hidden = true
    formView.hidden = false
    formTitle.textContent = title
    formErrorEl.hidden = true
    submitBtn.disabled = false
    submitLabel.textContent = prefill ? 'Save changes' : 'Add server'
    editingId = prefill?.id ?? null
    idTouched = Boolean(prefill)
    nameInput.value = prefill?.name ?? ''
    idInput.value = prefill?.id ?? ''
    idInput.disabled = Boolean(prefill)
    descriptionInput.value = prefill?.description ?? ''
    enabledCheckbox.checked = prefill?.enabled ?? true

    const isStdio = prefill?.transport === 'stdio'
    transport = prefill?.transport ?? 'http'
    commandInput.value = isStdio && prefill ? prefill.command : ''
    cwdInput.value = isStdio && prefill ? (prefill.cwd ?? '') : ''
    urlInput.value = isStdio || !prefill ? '' : prefill.url
    timeoutInput.value = isStdio || !prefill ? '' : String(prefill.timeout ?? 30)

    clearRows(argsList, argsRows)
    if (isStdio && prefill?.args) {
      for (const a of prefill.args) addArgRow(a)
    } else {
      addArgRow()
    }
    clearRows(envList, envRows)
    if (isStdio && prefill?.env) {
      for (const [k, v] of Object.entries(prefill.env)) {
        const row = makeKvRow(envRows, envList, 'e.g. FOO', 'e.g. bar')
        row.keyInput.value = k
        row.valueInput.value = v
      }
    }
    clearRows(headerList, headerRows)
    if (!isStdio && prefill?.headers) {
      for (const [k, v] of Object.entries(prefill.headers)) {
        const row = makeKvRow(headerRows, headerList, 'e.g. Authorization', 'e.g. Bearer …')
        row.keyInput.value = k
        row.valueInput.value = v
      }
    }
    renderTransport()
    hydrateIcons()
    nameInput.focus()
  }

  const showFormError = (message: string): void => {
    formErrorEl.textContent = message
    formErrorEl.hidden = false
  }

  const showListView = (): void => {
    listView.hidden = false
    formView.hidden = true
    formErrorEl.hidden = true
  }

  const startEdit = (info: McpServerInfo): void => {
    showForm(`Edit “${info.name}”`, info)
  }

  const buildConfig = (): McpServerConfig | null => {
    const name = nameInput.value.trim()
    const id = idInput.value.trim().toLowerCase()
    if (!name) {
      showFormError('Name is required.')
      return null
    }
    if (!id) {
      showFormError('ID is required.')
      return null
    }
    const base = {
      id,
      name,
      enabled: enabledCheckbox.checked,
      ...(descriptionInput.value.trim() ? { description: descriptionInput.value.trim() } : {}),
    }
    if (transport === 'stdio') {
      const command = commandInput.value.trim()
      if (!command) {
        showFormError('Command is required for STDIO transport.')
        return null
      }
      const args = argsRows.map((r) => r.value.trim()).filter(Boolean)
      const env = kvToObject(envRows.map((r) => ({ key: r.keyInput.value, value: r.valueInput.value })))
      const cwd = cwdInput.value.trim()
      return {
        ...base,
        transport: 'stdio',
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(cwd ? { cwd } : {}),
      } as McpServerConfig
    }
    const url = urlInput.value.trim()
    if (!url) {
      showFormError(`URL is required for ${transport.toUpperCase()} transport.`)
      return null
    }
    const headers = kvToObject(headerRows.map((r) => ({ key: r.keyInput.value, value: r.valueInput.value })))
    const parsedTimeout = Number(timeoutInput.value)
    return {
      ...base,
      transport: transport === 'sse' ? 'sse' : 'http',
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? { timeout: parsedTimeout } : {}),
    } as McpServerConfig
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void saveServer()
  })

  const saveServer = async (): Promise<void> => {
    const config = buildConfig()
    if (!config) return
    const validationError = validateMcpServerConfig(config)
    if (validationError) {
      showFormError(validationError)
      return
    }
    setSubmitting(true)
    try {
      if (editingId) await updateMcpServer(editingId, config)
      else await createMcpServer(config)
      showListView()
      void refresh()
      // Reconnect so the list shows a real status instead of a stale
      // "disconnected"; the follow-up refresh lands the final state.
      if (config.enabled !== false) {
        void connectMcpServer(config.id)
          .then(() => refresh())
          .catch(() => refresh())
      }
    } catch (e) {
      showFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const setSubmitting = (submitting: boolean): void => {
    submitBtn.disabled = submitting
    submitBtn.setAttribute('aria-busy', String(submitting))
    submitLabel.textContent = submitting ? 'Saving…' : editingId ? 'Save changes' : 'Add server'
  }

  renderTransport()
}

/**
 * Settings modal — provider API keys.
 *
 * Loads the keychain-backed credential states from the sidecar's
 * `/api/credentials` routes (helpers in src/renderer/credentials.ts) and
 * renders one row per provider. The API never returns raw keys — only a
 * masked hint like `sk-...abcd` — so the UI only knows whether a key
 * exists and lets the user add, replace or remove it. A typed key travels
 * once over localhost to the sidecar, which stores it in the OS keychain.
 *
 * Refreshes each time the settings modal opens (hideout:settings-opened,
 * dispatched by wireSettings).
 */
function wireCredentials(): void {
  const listEl = document.querySelector<HTMLElement>('#credentials-list')
  const loadingEl = document.querySelector<HTMLElement>('#credentials-loading')
  const errorEl = document.querySelector<HTMLElement>('#credentials-error')
  const retryBtn = document.querySelector<HTMLButtonElement>('#credentials-retry')
  const actionErrorEl = document.querySelector<HTMLElement>('#credentials-action-error')
  if (!listEl || !loadingEl || !errorEl || !retryBtn || !actionErrorEl) return

  const setState = (state: 'loading' | 'error' | 'list') => {
    loadingEl.hidden = state !== 'loading'
    errorEl.hidden = state !== 'error'
    listEl.hidden = state !== 'list'
  }

  const render = (credentials: CredentialState[]) => {
    listEl.replaceChildren(...credentials.map((c) => renderRow(c)))
  }

  const reloadQuiet = async (): Promise<void> => {
    try {
      const { credentials } = await listCredentials()
      render(credentials)
      actionErrorEl.hidden = true
    } catch {
      // Transient failure after an action — keep the current rows.
    }
  }

  const load = async (): Promise<void> => {
    setState('loading')
    actionErrorEl.hidden = true
    try {
      const { credentials } = await listCredentials()
      render(credentials)
      setState('list')
    } catch {
      setState('error')
    }
  }

  retryBtn.addEventListener('click', () => void load())
  window.addEventListener('hideout:settings-opened', () => void load())

  const inputCls =
    'min-w-0 flex-1 rounded-lg border border-line/70 bg-card/80 px-2.5 py-1.5 text-sm text-ink caret-ink outline-none transition-colors duration-150 placeholder:text-dim/60 focus:border-accent/70'

  const renderRow = (state: CredentialState): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'mcp-server-row flex-wrap'
    row.dataset.providerId = state.providerId

    const textCol = document.createElement('div')
    textCol.className = 'flex min-w-0 flex-1 flex-col gap-0.5'
    const name = document.createElement('span')
    name.className = 'truncate text-sm font-medium text-ink'
    name.textContent = providerLabel(state.providerId)
    textCol.appendChild(name)
    const detail = document.createElement('span')
    detail.className = 'truncate text-xs text-dim'
    detail.textContent = state.hasKey && state.maskedKey ? `Key stored — ${state.maskedKey}` : 'No key stored'
    textCol.appendChild(detail)
    row.appendChild(textCol)

    const actions = document.createElement('div')
    actions.className = 'flex shrink-0 items-center gap-2'

    const smallBtn = (label: string, tone: 'neutral' | 'accent' | 'danger'): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      const base = 'inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150'
      if (tone === 'accent') {
        b.className = `${base} border-accent/40 bg-accent/15 text-ink hover:bg-accent/25`
      } else if (tone === 'danger') {
        b.className = `${base} border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/70`
      } else {
        b.className = `${base} border-line/70 bg-card/80 text-dim hover:bg-black/10 hover:text-ink dark:hover:bg-white/10 dark:hover:text-ink`
      }
      b.textContent = label
      return b
    }

    const startEdit = () => {
      row.replaceChildren()
      const input = document.createElement('input')
      input.type = 'password'
      input.autocomplete = 'off'
      input.spellcheck = false
      input.placeholder = state.hasKey ? 'New API key' : 'Paste API key'
      input.className = inputCls
      const saveBtn = smallBtn('Save', 'accent')
      saveBtn.classList.add('font-semibold')
      const cancelBtn = smallBtn('Cancel', 'neutral')
      const errEl = document.createElement('p')
      errEl.className = 'w-full text-xs text-red-600 dark:text-red-400'
      errEl.hidden = true
      row.append(input, saveBtn, cancelBtn, errEl)
      input.focus()
      const commit = async () => {
        const key = input.value.trim()
        if (!key) {
          errEl.textContent = 'API key is required.'
          errEl.hidden = false
          return
        }
        saveBtn.disabled = true
        saveBtn.textContent = 'Saving…'
        try {
          await setCredential(state.providerId, key)
          await reloadQuiet()
        } catch (e) {
          errEl.textContent = e instanceof Error ? e.message : String(e)
          errEl.hidden = false
          saveBtn.disabled = false
          saveBtn.textContent = 'Save'
        }
      }
      saveBtn.addEventListener('click', () => void commit())
      cancelBtn.addEventListener('click', () => void reloadQuiet())
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void commit()
        } else if (e.key === 'Escape') {
          // Cancel the edit instead of closing the whole modal.
          e.preventDefault()
          e.stopPropagation()
          void reloadQuiet()
        }
      })
    }

    if (state.hasKey) {
      const replaceBtn = smallBtn('Replace', 'neutral')
      replaceBtn.addEventListener('click', startEdit)
      const removeBtn = smallBtn('Remove', 'danger')
      removeBtn.addEventListener('click', () => {
        void (async () => {
          try {
            await deleteCredential(state.providerId)
            await reloadQuiet()
          } catch (e) {
            actionErrorEl.textContent = e instanceof Error ? e.message : String(e)
            actionErrorEl.hidden = false
          }
        })()
      })
      actions.append(replaceBtn, removeBtn)
    } else {
      const addBtn = smallBtn('Add key', 'accent')
      addBtn.addEventListener('click', startEdit)
      actions.appendChild(addBtn)
    }
    row.appendChild(actions)
    return row
  }
}

/**
 * Chat thread wiring — renderer-side answering behavior.
 *
 * All chat/answering happens in the renderer (per spec): the renderer keeps
 * the conversation in a `ChatHistory`, renders into `#chat-thread`, and calls
 * the headless library `src/renderer/chat.ts` which hits `POST /api/chat`.
 * No UI markup is changed — messages are appended as plain DOM nodes that
 * inherit the existing palette and glass look.
 */
function wireChat(): void {
  const thread = document.querySelector<HTMLElement>('#chat-thread')
  const column = document.querySelector<HTMLElement>('#chat-column')
  const field = document.querySelector<HTMLTextAreaElement>('#composer-field')
  const sendBtn = document.querySelector<HTMLButtonElement>('#send-button') ?? document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')
  const stopBtn = document.querySelector<HTMLButtonElement>('#stop-button')
  if (!thread || !column || !field || !sendBtn) return

  const history = new ChatHistory()
  // Per-session concurrency: starting a new chat must not abort a
  // background stream. The old global `sending`/`abort` dropped the
  // previous chat's context entirely.
  const sendingSessions = new Set<string>()
  const abortControllers = new Map<string, AbortController>()
  type LiveChat = {
    root: HTMLElement
    answerEl: HTMLElement
    pending: HTMLElement
    controls: HTMLElement
    pillRow: HTMLElement
    reasoning: ReturnType<typeof buildReasoning> | null
    sourcesPill: HTMLElement | null
    sourcesPanel: HTMLElement | null
    sources: Source[]
    full: string
    thinking: string
    contentStarted: boolean
    anyDelta: boolean
  }
  const liveChats = new Map<string, LiveChat>()

  const scrollToBottom = () => {
    thread.scrollTop = thread.scrollHeight
  }

  const isActiveSession = (id: string): boolean => sessionStore.getActiveId() === id

  const updateSendingUI = (): void => {
    const activeId = sessionStore.getActiveId()
    const activeSending = activeId ? sendingSessions.has(activeId) : false
    field.disabled = activeSending
    sendBtn.setAttribute('aria-busy', String(activeSending))
    field.style.opacity = activeSending ? '0.7' : ''
    // Switch Send ↔ Stop: Stop only visible while the active session is generating
    if (stopBtn) {
      stopBtn.hidden = !activeSending
      sendBtn.hidden = activeSending
      stopBtn.setAttribute('aria-busy', String(activeSending))
    }
    if (!activeSending) {
      sendBtn.style.opacity = ''
      // Re-enable based on text when not sending the active session
      syncSendEnabled()
    } else {
      sendBtn.disabled = true
      sendBtn.style.opacity = '0.5'
    }
  }

  const setSendingFor = (sessionId: string, v: boolean) => {
    if (v) sendingSessions.add(sessionId)
    else sendingSessions.delete(sessionId)
    if (isActiveSession(sessionId)) updateSendingUI()
  }

  /** Bubbles only for user/system/error turns — the assistant answer is plain text. */
  const bubbleClass = (role: 'user' | 'system' | 'error') => {
    const base = 'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm'
    if (role === 'user') return `${base} user-message-bubble self-end text-ink`
    if (role === 'error') return `${base} self-start border border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200`
    // system
    return `${base} self-center bg-card/60 text-dim border border-line/60 text-xs`
  }

  const appendMessage = (role: 'user' | 'system' | 'error', content: string): HTMLElement => {
    // The message column (#chat-column) holds gap/padding already, so each
    // row is just its bubble, aligned within the centred column.
    const wrap = document.createElement('div')
    wrap.className = `flex w-full ${role === 'user' ? 'justify-end' : role === 'error' ? 'justify-start' : 'justify-center'}`
    const bubble = document.createElement('div')
    bubble.className = bubbleClass(role)
    // Keep line breaks and escape HTML — assistant turns may return markup-like text
    bubble.textContent = content
    wrap.appendChild(bubble)
    column.appendChild(wrap)
    scrollToBottom()
    return bubble
  }

  /**
   * Bare assistant turn: full-width plain text, no bubble. The container
   * leaves room for a collapsible reasoning panel that slides in above the
   * answer while the model is thinking.
   */
  const appendAssistantArea = (): { root: HTMLElement; answerEl: HTMLElement } => {
    const root = document.createElement('div')
    root.className = 'flex w-full flex-col gap-4'
    const answerEl = document.createElement('div')
    answerEl.className = 'markdown-content w-full break-words text-sm leading-relaxed text-ink'
    root.appendChild(answerEl)
    column.appendChild(root)
    scrollToBottom()
    return { root, answerEl }
  }

  const splitReasoningSteps = (text: string): string[] =>
    text
      .split(/\n{2,}/)
      .map((step) => step.trim())
      .filter(Boolean)

  // ── Reasoning pill & panel ─────────────────────────────────────
  // The model's thinking trace lives behind a "Reasoning" pill button that
  // sits next to the Sources pill (see `buildReasoning` and
  // `createSourcesPill`). Expanded, it shows the trace: a dotted spine
  // down the left, each row hung on a small gray dot. Steps are plain
  // muted text; tool uses expand to their result rows; a final "Done" row
  // with a circled check closes the trace.

  // Sparkles icon for the Reasoning pill (lucide "sparkles").
  const REASONING_ICON_PATH =
    'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0zM20 3v4M22 5h-4M4 17v2M5 18H3'

  const REASONING_TOOL_LABELS: Record<string, string> = {
    web_search: 'Used Web Search',
  }

  const toolLabel = (tool: string): string => REASONING_TOOL_LABELS[tool] ?? `Used ${tool.replace(/_/g, ' ')}`

  const SVG_NS = 'http://www.w3.org/2000/svg'

  const makeSvg = (pathD: string, cls: string): SVGSVGElement => {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.classList.add(cls)
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', pathD)
    svg.appendChild(path)
    return svg
  }

  /** iMessage/Messenger-style typing indicator: three dots that bounce in
      sequence (staggered by CSS) while the model is thinking. */
  const makeTypingDots = (): HTMLElement => {
    const wrap = document.createElement('span')
    wrap.className = 'typing-indicator'
    wrap.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span')
      dot.className = 'typing-dot'
      wrap.appendChild(dot)
    }
    return wrap
  }

  /** The timeline column marker: a small gray dot on the shared spine. */
  const makeMarker = (): HTMLElement => {
    const marker = document.createElement('span')
    marker.className = 'reasoning-marker'
    marker.setAttribute('aria-hidden', 'true')
    return marker
  }

  /**
   * One timeline row: marker + content. Spacing between rows comes from
   * the timeline container, so rows stay dumb and stackable.
   */
  const makeRow = (content: HTMLElement): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'reasoning-row'
    row.append(makeMarker(), content)
    return row
  }

  /** A plain thinking step: just text on the spine. */
  const makeStepRow = (text: string): HTMLElement => {
    const p = document.createElement('p')
    p.className = 'reasoning-step'
    p.textContent = text
    return makeRow(p)
  }

  /**
   * The closing "Done" row: circled check + label, exactly like the
   * screenshot's terminal marker under the last step.
   */
  const makeDoneRow = (): HTMLElement => {
    const btn = document.createElement('div')
    btn.className = 'reasoning-done'
    btn.appendChild(makeSvg('M22 11.08V12a10 10 0 1 1-5.93-9.14', 'reasoning-done-icon'))
    const span = document.createElement('span')
    span.textContent = 'Done'
    btn.appendChild(span)
    return makeRow(btn)
  }

  /**
   * A tool use row — "Used Web Search" with a wrench and a chevron.
   * Collapsed by default; clicking toggles the body beneath it (result
   * rows: the query, one row per source). The caller fills the body via
   * `.reasoning-tool-body` and may update it as more results stream in.
   */
  const makeToolRow = (tool: string): { row: HTMLElement; head: HTMLButtonElement; body: HTMLElement } => {
    const content = document.createElement('div')
    content.className = 'reasoning-tool'

    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'reasoning-tool-head'
    head.setAttribute('aria-expanded', 'false')
    head.appendChild(makeSvg('M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', 'reasoning-tool-icon'))
    const label = document.createElement('span')
    label.textContent = toolLabel(tool)
    head.appendChild(label)
    head.appendChild(makeSvg('m6 9 6 6 6-6', 'reasoning-tool-chevron'))

    const body = document.createElement('div')
    body.className = 'reasoning-tool-body'
    body.hidden = true

    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') !== 'true'
      head.setAttribute('aria-expanded', String(open))
      body.hidden = !open
    })

    content.append(head, body)
    return { row: makeRow(content), head, body }
  }

  /** One entry inside an expanded tool body: indented text on the spine. */
  const makeToolEntry = (text: string, url?: string): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'reasoning-tool-entry'
    if (url) {
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = text
      a.title = url
      row.appendChild(a)
    } else {
      row.textContent = text
    }
    return row
  }

  // ── Sources helpers ───────────────────────────────────────────────

  const sourceFaviconUrl = (src: Source): string | null => {
    if (src.favicon) return src.favicon
    try {
      const u = new URL(src.url)
      // Google's favicon service is reliable and avoids mixed-content issues
      return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`
    } catch {
      return null
    }
  }

  const sourceDomain = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }

  const sourceFallbackLetter = (url: string): string => {
    const d = sourceDomain(url)
    return (d[0] ?? 'W').toUpperCase()
  }

  const sourceTitle = (src: Source): string => {
    if (src.title && src.title.trim()) return src.title.trim()
    return sourceDomain(src.url)
  }

  /** Build the clickable pill + collapsible panel for a set of sources.
      Returns the pair so callers place them (the pill in the shared pill
      row, the panel in the controls column below it). */
  const createSourcesPill = (sources: Source[]): { pill: HTMLButtonElement; panel: HTMLElement } => {
    const pill = document.createElement('button')
    pill.type = 'button'
    pill.className = 'sources-pill'
    pill.setAttribute('aria-expanded', 'false')
    pill.setAttribute('aria-label', `${sources.length} source${sources.length === 1 ? '' : 's'} — click to ${sources.length === 1 ? 'view' : 'expand'}`)

    const icons = document.createElement('span')
    icons.className = 'sources-icons'
    icons.setAttribute('aria-hidden', 'true')
    const visibleIcons = sources.slice(0, 4)
    for (const src of visibleIcons) {
      const icon = document.createElement('span')
      icon.className = 'sources-icon'
      const fav = sourceFaviconUrl(src)
      if (fav) {
        const img = document.createElement('img')
        img.alt = ''
        img.loading = 'lazy'
        img.src = fav
        img.referrerPolicy = 'no-referrer'
        img.addEventListener('error', () => {
          // Fallback to letter on load failure
          img.remove()
          const fb = document.createElement('span')
          fb.className = 'sources-icon-fallback'
          fb.textContent = sourceFallbackLetter(src.url).slice(0, 1)
          // Keep single letter, not "W W"
          if (!icon.querySelector('.sources-icon-fallback')) icon.appendChild(fb)
        })
        icon.appendChild(img)
      } else {
        const fb = document.createElement('span')
        fb.className = 'sources-icon-fallback'
        fb.textContent = 'W'
        icon.appendChild(fb)
      }
      icons.appendChild(icon)
    }
    pill.appendChild(icons)

    const count = document.createElement('span')
    count.className = 'sources-count'
    count.textContent = `${sources.length} source${sources.length === 1 ? '' : 's'}`
    pill.appendChild(count)

    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    chevron.setAttribute('viewBox', '0 0 24 24')
    chevron.setAttribute('fill', 'none')
    chevron.setAttribute('stroke', 'currentColor')
    chevron.setAttribute('stroke-width', '2')
    chevron.setAttribute('stroke-linecap', 'round')
    chevron.setAttribute('stroke-linejoin', 'round')
    chevron.classList.add('sources-chevron')
    chevron.setAttribute('aria-hidden', 'true')
    const cPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    cPath.setAttribute('d', 'm9 18 6-6-6-6')
    chevron.appendChild(cPath)
    pill.appendChild(chevron)

    const panel = document.createElement('div')
    panel.className = 'sources-panel'
    panel.hidden = true

    const list = document.createElement('div')
    list.className = 'sources-list'
    for (const src of sources) {
      const a = document.createElement('a')
      a.className = 'sources-item'
      a.href = src.url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.title = src.url

      const favWrap = document.createElement('span')
      favWrap.className = 'sources-item-favicon'
      const fav = sourceFaviconUrl(src)
      if (fav) {
        const img = document.createElement('img')
        img.alt = ''
        img.loading = 'lazy'
        img.src = fav
        img.referrerPolicy = 'no-referrer'
        img.addEventListener('error', () => {
          img.remove()
          const fb = document.createElement('span')
          fb.className = 'sources-icon-fallback'
          fb.textContent = sourceFallbackLetter(src.url).slice(0, 1)
          fb.style.fontSize = '0.6rem'
          favWrap.appendChild(fb)
        })
        favWrap.appendChild(img)
      } else {
        const fb = document.createElement('span')
        fb.className = 'sources-icon-fallback'
        fb.textContent = sourceFallbackLetter(src.url).slice(0, 1)
        favWrap.appendChild(fb)
      }
      a.appendChild(favWrap)

      const textCol = document.createElement('span')
      textCol.className = 'sources-item-text'
      const titleEl = document.createElement('span')
      titleEl.className = 'sources-item-title'
      titleEl.textContent = sourceTitle(src)
      const urlEl = document.createElement('span')
      urlEl.className = 'sources-item-url'
      urlEl.textContent = src.url
      textCol.append(titleEl, urlEl)
      a.appendChild(textCol)

      const ext = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      ext.setAttribute('viewBox', '0 0 24 24')
      ext.setAttribute('fill', 'none')
      ext.setAttribute('stroke', 'currentColor')
      ext.setAttribute('stroke-width', '2')
      ext.classList.add('sources-item-external')
      const extPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      extPath.setAttribute('d', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3')
      ext.appendChild(extPath)
      a.appendChild(ext)

      list.appendChild(a)
    }
    panel.appendChild(list)

    pill.addEventListener('click', () => {
      const expanded = pill.getAttribute('aria-expanded') === 'true'
      const next = !expanded
      pill.setAttribute('aria-expanded', String(next))
      panel.hidden = !next
    })

    return { pill, panel }
  }

  /**
   * Build the full reasoning DOM for a finished turn: the pill button
   * ("Reasoning" / "Thinking" with a live step count) and the collapsible
   * panel holding the thinking steps, the web-search tool row (if sources
   * exist) and the closing Done row. Shared by the live stream and the
   * persisted re-render so both stay pixel-identical. The pill reuses the
   * Sources pill styling (`.sources-pill`); the panel reuses the sources
   * panel box (`.sources-panel`), matching the references.
   */
  // Reasoning panels always start collapsed — the user expands them by
  // clicking the pill. Expansion state lives in the DOM only (no
  // persistence), so every re-render (chat switch, app start) collapses
  // again. Stale `hideout.reasoning.*` keys from earlier builds are never
  // read and can be ignored.

  const buildReasoning = (opts: { thinking: string; sources: Source[]; query: string; active: boolean }): {
    pill: HTMLButtonElement
    label: HTMLElement
    count: HTMLElement
    panel: HTMLElement
    /** Where new step rows are appended while the model streams. */
    stepsBox: HTMLElement
    /** The tool row, present only when sources exist. */
    toolRow: HTMLElement | null
    /** The Done row, absent while `active` (still reasoning). */
    doneRow: HTMLElement | null
  } => {
    // Always collapsed initially, for live and finished turns alike — the
    // panel is enlarged only by an explicit user click below.
    const pill = document.createElement('button')
    pill.type = 'button'
    pill.className = 'sources-pill reasoning-pill'
    pill.setAttribute('aria-expanded', 'false')
    pill.setAttribute('aria-label', opts.active ? 'Thinking' : 'Reasoning')
    if (opts.active) {
      // Thinking state: the icon is replaced by an iMessage/Messenger-style
      // typing indicator and the label shimmers — see the CSS below.
      pill.classList.add('is-thinking')
      pill.appendChild(makeTypingDots())
    } else {
      pill.appendChild(makeSvg(REASONING_ICON_PATH, 'reasoning-pill-icon'))
    }
    const label = document.createElement('span')
    label.className = 'reasoning-pill-label'
    label.textContent = opts.active ? 'Thinking' : 'Reasoning'
    if (opts.active) label.classList.add('shimmer-text')
    pill.appendChild(label)
    const count = document.createElement('span')
    count.className = 'reasoning-pill-count'
    count.hidden = true
    pill.appendChild(count)
    // Trailing chevron in the same spot as the sources pill: points right
    // while collapsed and rotates 90deg to point down once expanded.
    pill.appendChild(makeSvg('m9 18 6-6-6-6', 'sources-chevron'))

    const panel = document.createElement('div')
    panel.className = 'sources-panel reasoning-panel'
    // Starts collapsed everywhere — finished turns included. The user opens
    // the trace by clicking the pill (see the click listener above).
    panel.hidden = true
    if (opts.active) panel.classList.add('is-active')

    pill.addEventListener('click', () => {
      const open = pill.getAttribute('aria-expanded') !== 'true'
      pill.setAttribute('aria-expanded', String(open))
      panel.hidden = !open
    })

    const stepsBox = document.createElement('div')
    stepsBox.className = 'reasoning-steps'
    panel.appendChild(stepsBox)

    let toolRow: HTMLElement | null = null
    if (opts.sources.length > 0) {
      const t = makeToolRow('web_search')
      toolRow = t.row
      t.body.append(
        makeToolEntry(`Search: ${opts.query || '…'}`),
        ...opts.sources.map((s) => makeToolEntry(sourceTitle(s), s.url)),
      )
      panel.appendChild(toolRow)
    }

    let doneRow: HTMLElement | null = null
    if (!opts.active) {
      doneRow = makeDoneRow()
      panel.appendChild(doneRow)
    }

    const steps = splitReasoningSteps(opts.thinking)
    stepsBox.replaceChildren(...steps.map(makeStepRow))
    if (steps.length > 0) {
      count.hidden = false
      count.textContent = steps.length === 1 ? '1 step' : `${steps.length} steps`
    }

    return { pill, label, count, panel, stepsBox, toolRow, doneRow }
  }

  const renderPersistedReasoning = (content: string, thinking: string, sources?: Source[], query?: string): HTMLElement => {
    const root = document.createElement('div')
    root.className = 'flex w-full flex-col gap-4'
    const answer = document.createElement('div')
    answer.className = 'markdown-content w-full break-words text-sm leading-relaxed text-ink'
    renderMarkdownHighlighted(answer, stripSourcesFromContent(content))
    root.appendChild(answer)
    // The Reasoning + Sources pills sit below the answer in one shared row,
    // each expanding into its own panel — same pill/panel language.
    const hasReasoning = Boolean(thinking.trim())
    const hasSources = sources !== undefined && sources.length > 0
    if (hasReasoning || hasSources) {
      const controls = document.createElement('div')
      controls.className = 'flex w-full flex-col gap-2'
      const pillRow = document.createElement('div')
      pillRow.className = 'flex flex-wrap items-center gap-2'
      controls.appendChild(pillRow)
      if (hasReasoning) {
        const r = buildReasoning({ thinking, sources: sources ?? [], query: query ?? '', active: false })
        pillRow.appendChild(r.pill)
        controls.appendChild(r.panel)
      }
      if (hasSources) {
        const s = createSourcesPill(sources as Source[])
        pillRow.appendChild(s.pill)
        controls.appendChild(s.panel)
      }
      root.appendChild(controls)
    }
    return root
  }

  const showError = (msg: string) => {
    appendMessage('error', msg)
  }

  const canSend = (): boolean => {
    const text = field.value.trim()
    if (!text) return false
    const activeId = sessionStore.getActiveId()
    if (activeId && sendingSessions.has(activeId)) return false
    return true
  }

  const syncSendEnabled = (): void => {
    const activeId = sessionStore.getActiveId()
    const activeSending = activeId ? sendingSessions.has(activeId) : false
    // While the active session is streaming, `updateSendingUI` owns disabled state
    if (activeSending) return
    const ok = canSend()
    sendBtn.disabled = !ok
    sendBtn.style.opacity = ok ? '' : '0.5'
  }

  field.addEventListener('input', syncSendEnabled)
  syncSendEnabled()

  const doSend = async () => {
    const raw = field.value.trim()
    if (!raw) return
    const sel = getSelectedModel()
    if (!sel) {
      showError('Select a model first — open the Models menu in the title bar and pick one.')
      field.focus()
      return
    }
    const activeIdForGuard = sessionStore.getActiveId()
    if (activeIdForGuard && sendingSessions.has(activeIdForGuard)) return

    // Ensure a persisted session for this conversation; a fresh send starts
    // a new one (title seeded from the first message) with empty history.
    let session = sessionStore.getActive()
    if (!session) {
      session = sessionStore.create(raw.slice(0, 48), [], { pinned: false })
      history.clear()
    }
    const sessionId = session.id

    // Optimistically add user bubble and clear the composer
    appendMessage('user', raw)
    history.add('user', raw)
    sessionStore.setMessages(sessionId, history.snapshot())
    field.value = ''
    field.dispatchEvent(new Event('input', { bubbles: true }))
    // Shrink the auto-grow textarea back
    field.style.height = 'auto'
    field.focus()

    const { root: assistantWrap, answerEl } = appendAssistantArea()
    // Shared row for the Reasoning + Sources pills, with their expandable
    // panels stacking beneath. Created up front so streaming steps and
    // late-arriving sources both land in the same controls column.
    const controls = document.createElement('div')
    controls.className = 'flex w-full flex-col gap-2'
    const pillRow = document.createElement('div')
    pillRow.className = 'flex flex-wrap items-center gap-2'
    controls.appendChild(pillRow)
    assistantWrap.appendChild(controls)
    let full = ''
    let thinking = ''
    let reasoning: ReturnType<typeof buildReasoning> | null = null
    let toolBody: HTMLElement | null = null
    let contentStarted = false
    let anyDelta = false
    const controller = new AbortController()
    abortControllers.set(sessionId, controller)

    // Shiny "thinking" shimmer shown from send until the first delta lands.
    const pending = document.createElement('div')
    pending.className = 'flex items-center text-sm text-dim'
    pending.innerHTML =
      '<span class="inline-flex items-center gap-1.5"><span class="shimmer-text font-medium">Thinking</span>' +
      '<span class="think-dots"><span class="think-dot"></span><span class="think-dot"></span><span class="think-dot"></span></span></span>'
    assistantWrap.appendChild(pending)
    let sources: Source[] = []
    let sourcesPill: HTMLElement | null = null
    let sourcesPanel: HTMLElement | null = null
    // Track live DOM so switching back to this session while it streams re-attaches it.
    liveChats.set(sessionId, {
      root: assistantWrap,
      answerEl,
      pending,
      controls,
      pillRow,
      reasoning: null,
      sourcesPill,
      sourcesPanel,
      sources,
      full: '',
      thinking: '',
      contentStarted: false,
      anyDelta: false,
    })
    setSendingFor(sessionId, true)
    // Snapshot messages at send time — don't re-read shared `history` which may be
    // cleared when the user switches to a new chat.
    const requestMessages = history.snapshot()

    // Reasoning trace → panel rows. Paragraphs (blank-line separated)
    // become steps; the last one grows live while the model thinks.
    const splitSteps = splitReasoningSteps

    // The Reasoning pill + panel are created lazily on the first thinking
    // delta, collapsed by default and labelled "Thinking" with a live step
    // count. Steps appear as they stream; the web-search tool row and the
    // Done row are appended to the panel as they happen.
    const ensureReasoning = () => {
      if (reasoning) return reasoning
      const r = buildReasoning({ thinking: '', sources: [], query: '', active: true })
      reasoning = r
      pillRow.appendChild(r.pill)
      controls.appendChild(r.panel)
      const live = liveChats.get(sessionId)
      if (live) live.reasoning = r
      return r
    }

    // Sources arrived mid-stream → append the "Used Web Search" row with
    // the query and source links in its expandable body.
    const ensureToolRow = (srcs: Source[]) => {
      if (toolBody) return
      const r = ensureReasoning()
      const tool = makeToolRow('web_search')
      tool.body.replaceChildren(
        makeToolEntry(`Search: ${raw || '…'}`),
        ...srcs.map((s) => makeToolEntry(sourceTitle(s), s.url)),
      )
      // Tool rows go after the growing steps box (inside the collapsible
      // panel); the Done row is appended later at finishReasoning, so it
      // stays last.
      r.panel.appendChild(tool.row)
      toolBody = tool.body
      const live = liveChats.get(sessionId)
      if (live) live.reasoning = r
    }

    const ensureSourcesBlock = (srcs: Source[]): void => {
      // Replace existing pill + panel if sources grew (e.g. second tool call)
      if (sourcesPill) {
        sourcesPill.remove()
        sourcesPanel?.remove()
      }
      const s = createSourcesPill(srcs)
      pillRow.appendChild(s.pill)
      controls.appendChild(s.panel)
      sourcesPill = s.pill
      sourcesPanel = s.panel
      const live = liveChats.get(sessionId)
      if (live) {
        live.sourcesPill = s.pill
        live.sourcesPanel = s.panel
        live.sources = srcs
      }
    }

    // Append/update the streaming step rows in place (no full rebuild per
    // delta — the growing last row just gets its text updated).
    const renderSteps = () => {
      if (!reasoning) ensureReasoning()
      const r = reasoning
      if (!r) return
      const steps = splitSteps(thinking)
      const box = r.stepsBox
      // Top up rows instead of rebuilding so the DOM stays stable while the
      // last row grows live.
      while (box.children.length > steps.length) box.lastElementChild?.remove()
      while (box.children.length < steps.length) box.appendChild(makeStepRow(''))
      steps.forEach((step, i) => {
        const p = box.children[i]?.querySelector<HTMLElement>('.reasoning-step')
        if (p) p.textContent = step
      })
      // Keep the pill's count in sync with the live step count.
      r.count.hidden = steps.length === 0
      if (steps.length > 0) r.count.textContent = steps.length === 1 ? '1 step' : `${steps.length} steps`
    }

    // Thinking finished: the pill settles back to its resting look — static
    // icon, plain "Reasoning" label — and the Done row stamps the panel.
    // Tool rows already sit between the steps and Done, in call order.
    const finishReasoning = () => {
      if (!reasoning || reasoning.doneRow) return
      const r = reasoning
      r.panel.classList.remove('is-active')
      r.pill.classList.remove('is-thinking')
      r.label.classList.remove('shimmer-text')
      r.label.textContent = 'Reasoning'
      const typing = r.pill.querySelector('.typing-indicator')
      if (typing) typing.replaceWith(makeSvg(REASONING_ICON_PATH, 'reasoning-pill-icon'))
      r.doneRow = makeDoneRow()
      r.panel.appendChild(r.doneRow)
    }

    const persistAssistant = (content: string, opts: { isAbort?: boolean } = {}): void => {
      const text = stripSourcesFromContent(content) || (opts.isAbort ? '' : '(empty reply)')
      const reasoning = thinking.trim()
      const srcs = sources.length > 0 ? sources.map((s) => ({ ...s })) : undefined
      // Only mutate shared `history` if this session is still active; otherwise
      // we would pollute the new chat's history (the original bug).
      if (isActiveSession(sessionId)) {
        if (text) {
          history.add('assistant', text)
          const assistant = history.all[history.length - 1]
          if (assistant) {
            if (reasoning) assistant.thinking = reasoning
            if (srcs) assistant.sources = srcs
          }
          sessionStore.setMessages(sessionId, history.snapshot())
        } else {
          // Persist reasoning/sources even when no content yet (e.g. abort)
          if (reasoning || srcs) {
            // Ensure an assistant placeholder exists to attach meta
            history.add('assistant', text)
            const assistant = history.all[history.length - 1]
            if (assistant) {
              if (reasoning) assistant.thinking = reasoning
              if (srcs) assistant.sources = srcs
            }
          }
          sessionStore.setMessages(sessionId, history.snapshot())
        }
      } else {
        if (text) sessionStore.appendMessages(sessionId, [{ role: 'assistant', content: text, ...(reasoning ? { thinking: reasoning } : {}), ...(srcs ? { sources: srcs } : {}) }])
        else if (reasoning || srcs) sessionStore.appendMessages(sessionId, [{ role: 'assistant', content: text, ...(reasoning ? { thinking: reasoning } : {}), ...(srcs ? { sources: srcs } : {}) }])
      }
    }

    // Reveal the buffered Sources pill once the answer is done (or aborted
    // with partial content). For background sessions the pill is detached
    // again and re-created from the live record when the session becomes
    // active (see the session-selected handler).
    const revealSources = (): void => {
      if (sources.length === 0) return
      ensureSourcesBlock(sources)
      if (!isActiveSession(sessionId)) {
        sourcesPill?.remove()
        sourcesPanel?.remove()
      }
    }

    try {
      const toolsEnabled = sessionStore.isToolsEnabled(sessionId)
      for await (const chunk of chatStream({
        providerId: sel.providerId,
        model: sel.id,
        messages: requestMessages,
        signal: controller.signal,
        toolsEnabled,
      })) {
        const live = liveChats.get(sessionId)
        if (!anyDelta) {
          anyDelta = true
          if (live) live.anyDelta = true
          pending.remove()
        }
        if (chunk.type === 'sources') {
          // Merge & dedupe by URL — multiple tool calls may emit incremental lists
          const seen = new Set(sources.map((s) => s.url))
          for (const s of chunk.sources) {
            if (!s.url || seen.has(s.url)) continue
            seen.add(s.url)
            sources.push({ url: s.url, title: s.title, favicon: s.favicon })
          }
          if (live) live.sources = [...sources]
          // Surface the tool use as a timeline row right away — the
          // "Used Web Search" entry with its expandable result list. For
          // background sessions this builds into the detached live root,
          // which re-attaches on session switch. The pill below the answer
          // still only appears once the answer is done.
          ensureToolRow(sources)
        } else if (chunk.type === 'thinking' && !contentStarted) {
          thinking += chunk.text
          if (live) live.thinking = thinking
          if (isActiveSession(sessionId)) sessionStore.setMessages(sessionId, history.snapshot())
          renderSteps()
        } else if (chunk.type === 'content') {
          if (!contentStarted) {
            contentStarted = true
            if (live) live.contentStarted = true
            finishReasoning()
          }
          full += chunk.text
          if (live) live.full = full
          renderMarkdownHighlighted(answerEl, stripSourcesFromContent(full))
        }
        if (isActiveSession(sessionId)) scrollToBottom()
      }
      if (isActiveSession(sessionId)) {
        if (!full) renderMarkdownHighlighted(answerEl, '(empty reply)')
        else renderMarkdownHighlighted(answerEl, stripSourcesFromContent(full))
      }
      // Answer finished — now reveal the sources pill (if any were buffered).
      revealSources()
      persistAssistant(full)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if ((e as Error).name === 'AbortError') {
        // Timeline may not exist if we never got a thinking delta; any tool
        // row still reads fine — just close the trace with Done.
        finishReasoning()
        if (full) renderMarkdownHighlighted(answerEl, stripSourcesFromContent(full) + ' — aborted')
        else answerEl.innerHTML = 'Aborted.'
        if (full) {
          revealSources()
          persistAssistant(full + ' — aborted', { isAbort: true })
        }
        else if (isActiveSession(sessionId)) {
          // No content yet — show aborted placeholder only if active
        }
      } else {
        // Replace the pending assistant turn with an error if we never got content
        if (!full) {
          assistantWrap.remove()
          // Keep live map in sync — detached root should not be re-attached
          liveChats.delete(sessionId)
          if (isActiveSession(sessionId)) showError(msg || 'Failed to get reply.')
        } else {
          renderMarkdownHighlighted(answerEl, stripSourcesFromContent(full))
          revealSources()
          if (isActiveSession(sessionId)) showError(msg)
        }
        if (full) persistAssistant(full)
      }
    } finally {
      pending.remove()
      const live = liveChats.get(sessionId)
      // If reasoning was still active, close the trace with the Done row
      if (!contentStarted && thinking) {
        finishReasoning()
      }
      // Cleanup live tracking: keep it for a background session that still
      // needs to be rendered on return? Actually after stream ends the
      // assistant message is persisted, so live DOM is no longer needed —
      // the session switch will render from store. Remove it.
      liveChats.delete(sessionId)
      if (live && !isActiveSession(sessionId)) {
        // Background session's DOM was detached; no need to keep it.
        try {
          live.root.remove()
        } catch {}
      }
      abortControllers.delete(sessionId)
      setSendingFor(sessionId, false)
      syncSendEnabled()
    }
  }

  const abortActive = (): void => {
    const activeId = sessionStore.getActiveId()
    if (activeId && sendingSessions.has(activeId)) {
      abortControllers.get(activeId)?.abort()
    }
  }

  sendBtn.addEventListener('click', () => void doSend())
  stopBtn?.addEventListener('click', () => abortActive())
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void doSend()
    }
    // Escape aborts the active session's in-flight stream only
    if (event.key === 'Escape') {
      abortActive()
    }
  })

  // New chat or session switch: clear or restore thread.
  // Background streams keep running — switching does NOT abort or
  // drop their context (fixes "reasoning doesn't finish" bug).
  window.addEventListener('hideout:session-selected', (e: Event) => {
    const id = (e as CustomEvent<string | null>).detail
    if (id === null) {
      // Clear active — abort all inflight (e.g. explicit new-chat without session)
      for (const c of abortControllers.values()) c.abort()
      abortControllers.clear()
      sendingSessions.clear()
      liveChats.clear()
      history.clear()
      column.replaceChildren()
      updateSendingUI()
      return
    }
    const session = sessionStore.get(id)
    if (!session) return
    // Restore messages for the selected session
    history.clear()
    for (const m of session.messages) history.push(m)
    column.replaceChildren()
    // If the target session is currently streaming in background, re-attach
    // its live DOM so the user sees "Thinking"/streaming resume.
    const live = liveChats.get(id)
    const isLive = !!live && sendingSessions.has(id)
    if (isLive && live) {
      // Render historic messages first (includes the user message), then
      // the live assistant area that is still streaming.
      let lastUserContent = ''
      for (const m of history.all) {
        if (m.role === 'user') {
          lastUserContent = m.content
          const wrap = document.createElement('div')
          wrap.className = 'flex w-full justify-end'
          const bubble = document.createElement('div')
          bubble.className = 'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm user-message-bubble self-end text-ink'
          bubble.textContent = m.content
          wrap.appendChild(bubble)
          column.appendChild(wrap)
        } else if (m.role === 'assistant') {
          // Already persisted assistant turns; live root holds the *current* pending turn
          // Include persisted sources so history shows the pill even before live attaches
          column.appendChild(renderPersistedReasoning(m.content, m.thinking ?? '', m.sources, lastUserContent))
        }
      }
      column.appendChild(live.root)
      // Sync answer text if it grew while detached
      renderMarkdownHighlighted(live.answerEl, stripSourcesFromContent(live.full))
      // Ensure the Sources pill is visible if it arrived while detached
      if (live.sources.length > 0 && (!live.sourcesPill || !live.sourcesPill.isConnected)) {
        // Re-create pill + panel now that we're back on this session
        const s = createSourcesPill(live.sources)
        live.pillRow.appendChild(s.pill)
        live.controls.appendChild(s.panel)
        live.sourcesPill = s.pill
        live.sourcesPanel = s.panel
      }
      // Ensure pending visibility reflects live state
      if (live.anyDelta && live.pending.parentElement) live.pending.remove()
      thread.scrollTop = thread.scrollHeight
      updateSendingUI()
      return
    }
    // Normal (non-live) render
    let lastUserContent = ''
    for (const m of history.all) {
      if (m.role === 'user') {
        lastUserContent = m.content
        const wrap = document.createElement('div')
        wrap.className = 'flex w-full justify-end'
        const bubble = document.createElement('div')
        bubble.className = 'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm user-message-bubble self-end text-ink'
        bubble.textContent = m.content
        wrap.appendChild(bubble)
        column.appendChild(wrap)
      } else if (m.role === 'assistant') {
        column.appendChild(renderPersistedReasoning(m.content, m.thinking ?? '', m.sources, lastUserContent))
      }
    }
    thread.scrollTop = thread.scrollHeight
    updateSendingUI()
    syncSendEnabled()
  })

  // Abort all on navigation/unload
  window.addEventListener('beforeunload', () => {
    for (const c of abortControllers.values()) c.abort()
  })

  // Hydrate the last chat after the selection listener is registered. The
  // active id is persisted by SessionStore, so reopening the app restores the
  // same conversation instead of showing an empty thread. On first launch (or
  // after all chats were deleted), create the requested empty draft.
  const active = sessionStore.getActive()
  const restored = active ?? sessionStore.create()
  window.dispatchEvent(new CustomEvent('hideout:session-selected', { detail: restored.id }))
}

initTheme()
wireThemeToggle()
wireComposer()
wireToolsToggle()
wireSettings()
wireCredentials()
wireChat()
