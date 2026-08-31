/**
 * The window's front end.
 *
 * Two jobs, kept deliberately tiny:
 *  1. Load htmx (plain, as a library - the markup in index.html stays plain
 *     HTML attributes, no JSX or component abstraction).
 *  2. Ask the Vantail runtime who the OS user is and drop the name into the
 *     hidden `#who` field, then let htmx fire the `/greet` request.
 */
import 'htmx.org'
import { appWindow, os, titleBarMetrics } from '@vantail/api'
import { ChevronDown, createIcons, Moon, PanelLeft, Search, Sun, X } from 'lucide'
import { DEFAULT_NAME, WHO_SELECTOR } from '../shared/constants.ts'

// Hydrate the Lucide icons declared as `<i data-lucide="…">` in index.html.
// The runtime swaps each placeholder for its SVG, keeping the element's own
// class and data-* attributes (e.g. `data-theme-icon`, `hidden`).
createIcons({ icons: { ChevronDown, Moon, PanelLeft, Search, Sun, X } })

// How far the macOS traffic lights settle below the bar's vertical centre, so
// the sidebar's toggle can sit on the very same row. One source of truth for
// both `setTrafficLightPosition` and the button alignment below.
const TITLEBAR_CONTROLS_PUSH = 18

// Trimmed, non-empty, and never used mid-tag - just a friendly name.
function usernameOf(home: string): string {
  const cleaned =
    home
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  return cleaned.length > 0 ? cleaned : DEFAULT_NAME
}

async function greetByOsUser(): Promise<void> {
  const field = document.querySelector<HTMLInputElement>(WHO_SELECTOR)
  if (!field) return

  let name: string = DEFAULT_NAME
  try {
    const home = await os.homeDir()
    name = usernameOf(home)
  } catch {
    // Outside Vantail (e.g. the page opened in a plain browser) there is no
    // runtime to answer; fall back to a friendly default.
    name = DEFAULT_NAME
  }

  if (field.value === name) return
  field.value = name
  field.dispatchEvent(new Event('change', { bubbles: true }))
}

void greetByOsUser()

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

  field.addEventListener('input', updateClear)
  clear.addEventListener('click', () => {
    field.value = ''
    updateClear()
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
      collapse()
      field.blur()
    }
  })
}

/**
 * The model-selector dropdown in the title bar. Clicking the pill toggles the
 * (empty, for now) menu beneath it; clicking anywhere else or pressing Escape
 * closes it. Pointer-down is stopped so the header's drag-to-move doesn't
 * fight the click.
 */
function wireModelSelector(): void {
  const selector = document.querySelector<HTMLElement>('#model-selector')
  const toggle = document.querySelector<HTMLButtonElement>('#model-selector-toggle')
  const menu = document.querySelector<HTMLElement>('#model-dropdown')
  const chevron = document.querySelector<HTMLElement>('#model-selector-chevron')
  if (!selector || !toggle || !menu || !chevron) return

  selector.addEventListener('pointerdown', (event) => event.stopPropagation())

  const setOpen = (open: boolean) => {
    toggle.setAttribute('aria-expanded', String(open))
    menu.hidden = !open
    chevron.classList.toggle('rotate-180', open)
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

wireSidebarResize()

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

initTheme()
wireThemeToggle()
