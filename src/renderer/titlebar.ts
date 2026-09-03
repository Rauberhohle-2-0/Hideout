/**
 * Custom title bar: window dragging, traffic-light alignment, the expandable
 * search, the new-chat button, and the model-selector dropdown.
 *
 * Platform access (`@vantail/api`) happens only through `./platform.ts`;
 * the model picker persists its choice via `./chat.ts` and lists models via
 * `./models.ts`.
 */
import { getSelectedModel, setSelectedModel, type SelectedModel } from './chat.ts'
import { sessionStore } from './sessions.ts'
import { listModels, type ApiModel } from './models.ts'
import { getTitleBarMetrics, setTrafficLightPosition, startWindowDrag } from './platform.ts'

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
export function wireTitleBar(): void {
  const bar = document.querySelector<HTMLElement>('[data-drag]')
  if (!bar) return

  bar.addEventListener('pointerdown', () => {
    startWindowDrag()
  })

  const { height = 36, buttonHeight = 14 } = getTitleBarMetrics()
  // Settle the lights a little below centre, and breathe off the leading edge.
  const y = Math.round(height / 2 - buttonHeight / 2 + TITLEBAR_CONTROLS_PUSH)
  setTrafficLightPosition(20, y)

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

/**
 * Expand/collapse the title-bar search. Clicking the (closed) circle slides it
 * open into a search field and focuses it; the field collapses again when it
 * loses focus or Escape is pressed. Stops pointer-down from bubbling so the
 * header's drag-to-move doesn't fight the click.
 */
export function wireTitleBarSearch(): void {
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
export function wireNewChatButton(): void {
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
 * `GET /api/models` (via `./models.ts`) and shown in the dropdown. Selecting
 * a row persists the choice in `localStorage` (via `src/renderer/chat.ts`)
 * and updates the toggle label — the chat library reads that same key when
 * sending.
 */
export function wireModelSelector(): void {
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

  const renderModels = (models: ApiModel[]) => {
    menu.replaceChildren()
    if (models.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'px-3 py-2 text-sm text-dim'
      empty.textContent = 'No models available'
      menu.appendChild(empty)
      // If the persisted selection vanished (provider removed), the stale
      // label is kept until the next successful fetch — the chat composer
      // will warn "no models available" when the user tries to send.
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
    renderModels(await listModels())
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
