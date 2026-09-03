/**
 * Left sidebar: collapse/expand, resize drag, collapsible sections, and the
 * pinned/recent chat session lists with rename/pin/delete/select actions.
 *
 * Rows render from `sessionStore`; clicking one makes it active and
 * dispatches `hideout:session-selected` so the chat thread can render its
 * messages. The store persists to localStorage and filters via the
 * title-bar search.
 */
import { sessionStore, type ChatSession } from './sessions.ts'
import { hydrateIcons } from './icons.ts'

// Shared handles used by the toggle and the resize wiring. Re-bound at wire
// time (see `wireSidebar`) so a re-boot against a fresh document — e.g. the
// test harness booting several files in one shared module registry — picks
// up the current DOM instead of the first boot's detached tree.
let sidebar: HTMLElement | null = null
let sidebarToggles: HTMLButtonElement[] = []

/**
 * Collapse/enlarge the left sidebar and keep its toggle in sync.
 *
 * A single toggle lives in the right-side title-bar pill, which stays visible
 * in both states, so the window controls are always reachable.
 */
function setSidebarCollapsed(collapsed: boolean, animating: boolean = true): void {
  const sb = sidebar
  if (!sb) return
  if (collapsed) {
    // Hide the toggle the moment collapsing starts, before the width animation
    // squishes it; the width transition then finishes the collapse.
    sb.classList.add('collapsing')
    sb.classList.add('collapsed')
  } else if (animating) {
    // Keep it hidden while the sidebar grows back; a width transitionend
    // (below) reveals it again.
    sb.classList.add('collapsing')
    sb.classList.remove('collapsed')
  } else {
    // No animation (e.g. a manual resize drag): reveal straight away.
    sb.classList.remove('collapsing')
    sb.classList.remove('collapsed')
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
  const sb = sidebar
  if (!sb) return
  for (const toggle of sidebarToggles) {
    toggle.addEventListener('click', () => {
      setSidebarCollapsed(!sb.classList.contains('collapsed'))
    })
  }
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
  const sb = sidebar
  if (!sb || !handle) return

  const minWidth = 160
  handle.addEventListener('pointerdown', (event) => {
    sb.classList.add('dragging')
    setSidebarCollapsed(false, false) // a drag resizes it open, no hiding
    handle.setPointerCapture(event.pointerId)
    event.preventDefault()
  })

  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return
    const maxWidth = Math.max(minWidth, Math.floor(window.innerWidth * 0.5))
    const width = Math.min(maxWidth, Math.max(minWidth, event.clientX))
    sb.style.width = `${width}px`
  })

  const endDrag = () => sb.classList.remove('dragging')
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
    hydrateIcons(['MessageCircle', 'Pin', 'PinOff', 'Trash2'])

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
 * Wire the whole sidebar feature: the collapse/expand toggle, the reveal-on-
 * transition-end behaviour, the resize drag handle, collapsible sections and
 * the session lists. Call once at startup, after the title bar is wired.
 */
export function wireSidebar(): void {
  sidebar = document.querySelector<HTMLElement>('#sidebar')
  sidebarToggles = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-sidebar-toggle]'))
  const sb = sidebar
  if (sb) {
    wireSidebarToggle()

    // Reveal the sidebar's toggle once the collapse/expand width animation ends.
    sb.addEventListener('transitionend', (event) => {
      if (event.propertyName === 'width') sb.classList.remove('collapsing')
    })
  }

  wireSidebarResize()
  wireSidebarSectionsCollapsible()
  wireSidebarSessions()
}
