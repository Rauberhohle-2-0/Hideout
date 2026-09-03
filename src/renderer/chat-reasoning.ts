/**
 * Chat reasoning UI — the collapsible "Thinking/Reasoning" trace shown under
 * an assistant turn.
 *
 * The model's thinking trace lives behind a pill button that sits next to
 * the Sources pill (see `createSourcesPill` in ./chat-sources.ts). Expanded,
 * it shows the trace: a dotted spine down the left, each row hung on a small
 * gray dot. Steps are plain muted text; tool uses expand to their result
 * rows; a final "Done" row with a circled check closes the trace.
 *
 * Reasoning panels always start collapsed — the user expands them by
 * clicking the pill. Expansion state lives in the DOM only (no
 * persistence), so every re-render (chat switch, app start) collapses
 * again. Stale `hideout.reasoning.*` keys from earlier builds are never
 * read and can be ignored.
 *
 * Everything in this module is a DOM builder; live streaming/step updates
 * are orchestrated by the chat controller.
 */
import type { Source } from './chat.ts'
import { sanitizeSources, sourceTitle } from './chat-sources.ts'

// Sparkles icon for the Reasoning pill (lucide "sparkles").
const REASONING_ICON_PATH =
  'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0zM20 3v4M22 5h-4M4 17v2M5 18H3'

const REASONING_TOOL_LABELS: Record<string, string> = {
  web_search: 'Used Web Search',
}

function toolLabel(tool: string): string {
  return REASONING_TOOL_LABELS[tool] ?? `Used ${tool.replace(/_/g, ' ')}`
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function makeSvg(pathD: string, cls: string): SVGSVGElement {
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

/** Split a thinking trace into steps: blank-line separated paragraphs. */
export function splitReasoningSteps(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((step) => step.trim())
    .filter(Boolean)
}

/** iMessage/Messenger-style typing indicator: three dots that bounce in
    sequence (staggered by CSS) while the model is thinking. */
function makeTypingDots(): HTMLElement {
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
function makeMarker(): HTMLElement {
  const marker = document.createElement('span')
  marker.className = 'reasoning-marker'
  marker.setAttribute('aria-hidden', 'true')
  return marker
}

/**
 * One timeline row: marker + content. Spacing between rows comes from
 * the timeline container, so rows stay dumb and stackable.
 */
function makeRow(content: HTMLElement): HTMLElement {
  const row = document.createElement('div')
  row.className = 'reasoning-row'
  row.append(makeMarker(), content)
  return row
}

/** A plain thinking step: just text on the spine. */
export function makeStepRow(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'reasoning-step'
  p.textContent = text
  return makeRow(p)
}

/**
 * The closing "Done" row: circled check + label, exactly like the
 * screenshot's terminal marker under the last step.
 */
export function makeDoneRow(): HTMLElement {
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
export function makeToolRow(tool: string): { row: HTMLElement; head: HTMLButtonElement; body: HTMLElement } {
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
export function makeToolEntry(text: string, url?: string): HTMLElement {
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

/** The resting sparkles icon used once a turn stops thinking. */
export function makeReasoningPillIcon(): SVGSVGElement {
  return makeSvg(REASONING_ICON_PATH, 'reasoning-pill-icon')
}

export type ReasoningBuild = {
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
}

/**
 * Build the full reasoning DOM for a turn: the pill button ("Reasoning" /
 * "Thinking" with a live step count) and the collapsible panel holding the
 * thinking steps, the web-search tool row (if sources exist) and the closing
 * Done row. Shared by the live stream and the persisted re-render so both
 * stay pixel-identical. The pill reuses the Sources pill styling
 * (`.sources-pill`); the panel reuses the sources panel box
 * (`.sources-panel`), matching the references.
 */
export function buildReasoning(opts: {
  thinking: string
  sources: Source[]
  query: string
  active: boolean
}): ReasoningBuild {
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
    pill.appendChild(makeReasoningPillIcon())
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

  const sources = sanitizeSources(opts.sources)
  let toolRow: HTMLElement | null = null
  if (sources.length > 0) {
    const t = makeToolRow('web_search')
    toolRow = t.row
    t.body.append(
      makeToolEntry(`Search: ${opts.query || '…'}`),
      ...sources.map((s) => makeToolEntry(sourceTitle(s), s.url)),
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
