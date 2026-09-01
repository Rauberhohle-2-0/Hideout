/**
 * The window's front end.
 *
 * Small and plain: hydrate the Lucide icons declared as `<i data-lucide="…">`
 * in index.html, then wire up the custom title bar, sidebar and theme.
 */
import { appWindow, titleBarMetrics } from '@vantail/api'
import { ChevronDown, createIcons, MessageCircle, Mic, Moon, PanelLeft, Pencil, Pin, PinOff, Plus, Search, SendHorizontal, Settings, SquarePen, Sun, Trash2, Wrench, X } from 'lucide'
import { ChatHistory, chatStream, getSelectedModel, setSelectedModel, type SelectedModel } from './chat.ts'
import { sessionStore, type ChatSession } from './sessions.ts'

// Hydrate the Lucide icons declared as `<i data-lucide="…">` in index.html.
// The runtime swaps each placeholder for its SVG, keeping the element's own
// class and data-* attributes (e.g. `data-theme-icon`, `hidden`).
createIcons({ icons: { ChevronDown, MessageCircle, Mic, Moon, PanelLeft, Pencil, Pin, PinOff, Plus, Search, SendHorizontal, Settings, SquarePen, Sun, Trash2, Wrench, X } })

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
    const session = sessionStore.create(undefined, [], { pinned: false })
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
  const sendBtn = document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')
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
    details: HTMLDetailsElement | null
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
    sendBtn.style.opacity = activeSending ? '0.5' : ''
    field.style.opacity = activeSending ? '0.7' : ''
    if (!activeSending) {
      // Re-enable based on text when not sending the active session
      syncSendEnabled()
    } else {
      sendBtn.disabled = true
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
    wrap.className = role === 'user' ? 'flex w-full justify-end' : 'flex w-full justify-center'
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
    answerEl.className = 'w-full whitespace-pre-wrap break-words text-sm leading-relaxed text-ink'
    root.appendChild(answerEl)
    column.appendChild(root)
    scrollToBottom()
    return { root, answerEl }
  }

  const splitReasoningSteps = (text: string): string[] =>
    text
      .split(/\\n{2,}/)
      .map((step) => step.trim())
      .filter(Boolean)

  const renderPersistedReasoning = (content: string, thinking: string): HTMLElement => {
    const root = document.createElement('div')
    root.className = 'flex w-full flex-col gap-4'
    if (thinking) {
      const details = document.createElement('details')
      details.className = 'reasoning-panel'
      const summary = document.createElement('summary')
      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      chevron.setAttribute('viewBox', '0 0 24 24')
      chevron.setAttribute('fill', 'none')
      chevron.setAttribute('stroke', 'currentColor')
      chevron.setAttribute('stroke-width', '2')
      chevron.classList.add('reasoning-chevron')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'm6 9 6 6 6-6')
      chevron.appendChild(path)
      summary.appendChild(chevron)
      const title = document.createElement('span')
      title.className = 'font-medium'
      title.textContent = 'Reasoning'
      summary.appendChild(title)
      const badge = document.createElement('span')
      badge.className = 'reasoning-badge'
      badge.textContent = splitReasoningSteps(thinking).length === 1 ? '1 step' : `${splitReasoningSteps(thinking).length} steps`
      summary.appendChild(badge)
      const steps = document.createElement('div')
      steps.className = 'reasoning-steps'
      splitReasoningSteps(thinking).forEach((step, index) => {
        const row = document.createElement('div')
        row.className = 'reasoning-step'
        const number = document.createElement('span')
        number.className = 'reasoning-step-num'
        number.textContent = `Step ${index + 1}`
        const text = document.createElement('div')
        text.textContent = step
        row.append(number, text)
        steps.appendChild(row)
      })
      details.append(summary, steps)
      root.appendChild(details)
    }
    const answer = document.createElement('div')
    answer.className = 'w-full whitespace-pre-wrap break-words text-sm leading-relaxed text-ink'
    answer.textContent = content
    root.appendChild(answer)
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
    let full = ''
    let thinking = ''
    let details: HTMLDetailsElement | null = null
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
    // Track live DOM so switching back to this session while it streams re-attaches it.
    liveChats.set(sessionId, {
      root: assistantWrap,
      answerEl,
      pending,
      details,
      full: '',
      thinking: '',
      contentStarted: false,
      anyDelta: false,
    })
    setSendingFor(sessionId, true)
    // Snapshot messages at send time — don't re-read shared `history` which may be
    // cleared when the user switches to a new chat.
    const requestMessages = history.snapshot()

    // Reasoning trace → numbered steps. Paragraphs (blank-line separated)
    // become steps; the last one grows live while the model thinks.
    const splitSteps = (text: string): string[] =>
      text
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean)

    // The collapsible <details> panel is created lazily on the first
    // thinking delta, collapsed but glowing while reasoning is in progress;
    // the user can click it open at any time.
    const ensureDetails = (): HTMLDetailsElement => {
      if (details) return details
      const d = document.createElement('details')
      d.className = 'reasoning-panel reasoning-active'
      d.open = false

      const summary = document.createElement('summary')
      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      chevron.setAttribute('viewBox', '0 0 24 24')
      chevron.setAttribute('fill', 'none')
      chevron.setAttribute('stroke', 'currentColor')
      chevron.setAttribute('stroke-width', '2')
      chevron.classList.add('reasoning-chevron')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'm6 9 6 6 6-6')
      chevron.appendChild(path)
      summary.appendChild(chevron)

      const title = document.createElement('span')
      title.dataset.reasoningTitle = 'true'
      title.className = 'shimmer-text font-medium'
      title.textContent = 'Thinking'
      summary.appendChild(title)

      const dots = document.createElement('span')
      dots.className = 'think-dots'
      dots.innerHTML =
        '<span class="think-dot"></span><span class="think-dot"></span><span class="think-dot"></span>'
      summary.appendChild(dots)

      const badge = document.createElement('span')
      badge.dataset.reasoningBadge = 'true'
      badge.className = 'reasoning-badge'
      badge.hidden = true
      summary.appendChild(badge)

      const stepsEl = document.createElement('div')
      stepsEl.dataset.reasoningSteps = 'true'
      stepsEl.className = 'reasoning-steps'

      d.appendChild(summary)
      d.appendChild(stepsEl)
      assistantWrap.insertBefore(d, answerEl)
      details = d
      const live = liveChats.get(sessionId)
      if (live) live.details = d
      return d
    }

    // Load-bearing accessor: nested-function reads of `details` never narrow
    // (see the AbortError branch), a bare read does.
    const currentDetails = (): HTMLDetailsElement | null => details

    const renderSteps = () => {
      const d = ensureDetails()
      const box = d.querySelector<HTMLElement>('[data-reasoning-steps]')
      if (!box) return
      box.replaceChildren()
      splitSteps(thinking).forEach((step, i) => {
        const row = document.createElement('div')
        row.className = 'reasoning-step'
        const num = document.createElement('span')
        num.className = 'reasoning-step-num'
        num.textContent = `Step ${i + 1}`
        const text = document.createElement('div')
        text.textContent = step
        row.appendChild(num)
        row.appendChild(text)
        box.appendChild(row)
      })
    }

    // Thinking finished: kill the glow and stamp the summary with the step
    // count. The panel keeps whatever open/collapsed state the user chose.
    const finishReasoning = () => {
      if (!details) return
      details.classList.remove('reasoning-active')
      const title = details.querySelector<HTMLElement>('[data-reasoning-title]')
      if (title) {
        title.classList.remove('shimmer-text')
        title.textContent = 'Reasoning'
      }
      details.querySelector('.think-dots')?.remove()
      const steps = splitSteps(thinking)
      const badge = details.querySelector<HTMLElement>('[data-reasoning-badge]')
      if (badge) {
        badge.hidden = false
        badge.textContent = steps.length === 1 ? '1 step' : `${steps.length} steps`
      }
      renderSteps()
    }

    const persistAssistant = (content: string, opts: { isAbort?: boolean } = {}): void => {
      const text = content || (opts.isAbort ? '' : '(empty reply)')
      const reasoning = thinking.trim()
      // Only mutate shared `history` if this session is still active; otherwise
      // we would pollute the new chat's history (the original bug).
      if (isActiveSession(sessionId)) {
        if (text) {
          history.add('assistant', text)
          const assistant = history.all[history.length - 1]
          if (assistant && reasoning) assistant.thinking = reasoning
          sessionStore.setMessages(sessionId, history.snapshot())
        } else {
          sessionStore.setMessages(sessionId, history.snapshot())
        }
      } else {
        if (text) sessionStore.appendMessages(sessionId, [{ role: 'assistant', content: text, ...(reasoning ? { thinking: reasoning } : {}) }])
      }
    }

    try {
      for await (const chunk of chatStream({
        providerId: sel.providerId,
        model: sel.id,
        messages: requestMessages,
        signal: controller.signal,
      })) {
        const live = liveChats.get(sessionId)
        if (!anyDelta) {
          anyDelta = true
          if (live) live.anyDelta = true
          pending.remove()
        }
        if (chunk.type === 'thinking' && !contentStarted) {
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
          answerEl.textContent = full
        }
        if (isActiveSession(sessionId)) scrollToBottom()
      }
      if (isActiveSession(sessionId)) {
        if (!full) answerEl.textContent = '(empty reply)'
      }
      persistAssistant(full)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if ((e as Error).name === 'AbortError') {
        // `details` is only assigned inside `ensureDetails`, so flow analysis
        // still believes it is null in this scope; go through the accessor.
        currentDetails()?.classList.remove('reasoning-active')
        currentDetails()?.querySelector('.think-dots')?.remove()
        answerEl.textContent = full ? full + ' — aborted' : 'Aborted.'
        if (full) persistAssistant(full + ' — aborted', { isAbort: true })
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
          answerEl.textContent = full
          if (isActiveSession(sessionId)) showError(msg)
        }
        if (full) persistAssistant(full)
      }
    } finally {
      pending.remove()
      const live = liveChats.get(sessionId)
      // If reasoning was still active, finalize its badge state
      if (!contentStarted && thinking) {
        // still thinking but stream ended without content — finalize panel
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

  sendBtn.addEventListener('click', () => void doSend())
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void doSend()
    }
    // Escape aborts the active session's in-flight stream only
    if (event.key === 'Escape') {
      const activeId = sessionStore.getActiveId()
      if (activeId && sendingSessions.has(activeId)) {
        abortControllers.get(activeId)?.abort()
      }
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
      for (const m of history.all) {
        if (m.role === 'user') {
          const wrap = document.createElement('div')
          wrap.className = 'flex w-full justify-end'
          const bubble = document.createElement('div')
          bubble.className = 'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm user-message-bubble self-end text-ink'
          bubble.textContent = m.content
          wrap.appendChild(bubble)
          column.appendChild(wrap)
        } else if (m.role === 'assistant') {
          // Already persisted assistant turns; live root holds the *current* pending turn
          const wrap = document.createElement('div')
          wrap.className = 'flex w-full flex-col gap-4'
          const answerEl = document.createElement('div')
          answerEl.className = 'w-full whitespace-pre-wrap break-words text-sm leading-relaxed text-ink'
          answerEl.textContent = m.content
          wrap.appendChild(answerEl)
          column.appendChild(wrap)
        }
      }
      column.appendChild(live.root)
      // Sync answer text if it grew while detached
      live.answerEl.textContent = live.full
      // Ensure pending visibility reflects live state
      if (live.anyDelta && live.pending.parentElement) live.pending.remove()
      thread.scrollTop = thread.scrollHeight
      updateSendingUI()
      return
    }
    // Normal (non-live) render
    for (const m of history.all) {
      if (m.role === 'user') {
        const wrap = document.createElement('div')
        wrap.className = 'flex w-full justify-end'
        const bubble = document.createElement('div')
        bubble.className = 'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm user-message-bubble self-end text-ink'
        bubble.textContent = m.content
        wrap.appendChild(bubble)
        column.appendChild(wrap)
      } else if (m.role === 'assistant') {
        column.appendChild(renderPersistedReasoning(m.content, m.thinking ?? ''))
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
wireChat()
