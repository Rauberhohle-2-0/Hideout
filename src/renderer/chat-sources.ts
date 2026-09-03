/**
 * Chat sources UI — the clickable "N sources" pill and its collapsible panel
 * of external links, plus the pure URL helpers behind them.
 *
 * Source URLs are untrusted (they originate from MCP web-search results and
 * persisted sessions), so every value is validated against
 * `isAllowedHttpUrl` before it becomes an anchor or a favicon request —
 * defense-in-depth on top of the sidecar's own filtering in
 * `src/main/server.ts`.
 */
import type { Source } from './chat.ts'
import { isAllowedHttpUrl } from '../shared/safe-url.ts'

/**
 * Validate and normalize a list of sources. Drops entries without an
 * absolute http(s) URL and copies only the fields the UI renders
 * (`url`, `title`, `favicon`). Pure — no DOM.
 */
export function sanitizeSources(raw: readonly Source[]): Source[] {
  const out: Source[] = [];
  for (const s of raw) {
    if (!s || !isAllowedHttpUrl(s.url)) continue;
    const src: Source = { url: s.url };
    if (s.title !== undefined) src.title = s.title;
    if (s.favicon !== undefined) src.favicon = s.favicon;
    out.push(src);
  }
  return out;
}

/** The favicon to show for a source, or null for a letter fallback. */
export function sourceFaviconUrl(src: Source): string | null {
  // A model/MCP-provided favicon must also be http(s) — never data:/file:/….
  if (isAllowedHttpUrl(src.favicon)) return src.favicon;
  if (!isAllowedHttpUrl(src.url)) return null;
  try {
    const u = new URL(src.url)
    // Google's favicon service is reliable and avoids mixed-content issues
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`
  } catch {
    return null
  }
}

/** Host of a source URL, minus a leading `www.` (raw URL on parse failure). */
export function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Single-letter avatar for a source whose favicon cannot load. */
export function sourceFallbackLetter(url: string): string {
  const d = sourceDomain(url)
  return (d[0] ?? 'W').toUpperCase()
}

/** Human label for a source: its title, or the host when untitled. */
export function sourceTitle(src: Source): string {
  if (src.title && src.title.trim()) return src.title.trim()
  return sourceDomain(src.url)
}

/** Build the clickable pill + collapsible panel for a set of sources.
    Returns the pair so callers place them (the pill in the shared pill
    row, the panel in the controls column below it). */
export function createSourcesPill(rawSources: Source[]): { pill: HTMLButtonElement; panel: HTMLElement } {
  const sources = sanitizeSources(rawSources)
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
