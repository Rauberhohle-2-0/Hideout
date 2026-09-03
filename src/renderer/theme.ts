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

/** Apply the persisted (or system) theme once at startup. */
export function initTheme(): void {
  let dark: boolean
  try {
    const stored = localStorage.getItem(THEME_KEY)
    dark = stored === 'dark' || (stored === null && window.matchMedia('(prefers-color-scheme: dark)').matches)
  } catch {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  applyTheme(dark)
}

/** Wire every theme toggle button. */
export function wireThemeToggle(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    button.addEventListener('click', () => applyTheme(!themeIsDark()))
  }
}
