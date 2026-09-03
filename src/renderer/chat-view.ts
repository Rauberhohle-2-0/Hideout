/**
 * Chat thread view — DOM builders for the conversation column.
 *
 * Stateless builders only: they take the containers they append to and know
 * nothing about sessions, streaming or abort state. The controller in
 * `./chat-controller.ts` decides *when* these run.
 */
import { renderMarkdownHighlighted } from './highlight.ts'
import { stripSourcesFromContent, type Source } from '../shared/chat.ts'
import { buildReasoning } from './chat-reasoning.ts'
import { createSourcesPill } from './chat-sources.ts'

type BubbleRole = 'user' | 'system' | 'error'

/** Bubbles only for user/system/error turns — the assistant answer is plain text. */
function bubbleClass(role: BubbleRole): string {
  const base = 'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm'
  if (role === 'user') return `${base} user-message-bubble self-end text-ink`
  if (role === 'error') return `${base} self-start border border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200`
  // system
  return `${base} self-center bg-card/60 text-dim border border-line/60 text-xs`
}

/** Wrapper + bubble for a user message, aligned right within the column. */
export function createUserBubble(content: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'flex w-full justify-end'
  const bubble = document.createElement('div')
  bubble.className = bubbleClass('user')
  // Keep line breaks and escape HTML — user input may contain markup-like text
  bubble.textContent = content
  wrap.appendChild(bubble)
  return wrap
}

/**
 * Append a user/system/error bubble to the column and pin the thread to the
 * bottom. Returns the bubble element.
 */
export function appendMessage(
  column: HTMLElement,
  thread: HTMLElement,
  role: BubbleRole,
  content: string,
): HTMLElement {
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
  thread.scrollTop = thread.scrollHeight
  return bubble
}

/**
 * Bare assistant turn: full-width plain text, no bubble. The container
 * leaves room for a collapsible reasoning panel that slides in above the
 * answer while the model is thinking.
 */
export function appendAssistantArea(column: HTMLElement, thread: HTMLElement): { root: HTMLElement; answerEl: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'flex w-full flex-col gap-4'
  const answerEl = document.createElement('div')
  answerEl.className = 'markdown-content w-full break-words text-sm leading-relaxed text-ink'
  root.appendChild(answerEl)
  column.appendChild(root)
  thread.scrollTop = thread.scrollHeight
  return { root, answerEl }
}

/**
 * Render one persisted assistant turn: markdown answer with the Reasoning +
 * Sources pills (each expanding into its own panel) below it. Returns the
 * root node for the caller to append.
 */
export function renderPersistedReasoning(
  content: string,
  thinking: string,
  sources?: Source[],
  query?: string,
): HTMLElement {
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
