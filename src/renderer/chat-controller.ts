/**
 * Chat thread controller — renderer-side answering behavior.
 *
 * All chat/answering happens in the renderer (per spec): the controller keeps
 * the conversation in a `ChatHistory`, renders into `#chat-thread`, and calls
 * the headless library `src/renderer/chat.ts` which hits `POST /api/chat`.
 *
 * This module owns the mutable chat lifecycle state — history, which
 * sessions are streaming, their abort controllers, and the "live" DOM record
 * for background streams — and uses the pure builders in `./chat-view.ts`,
 * `./chat-reasoning.ts` and `./chat-sources.ts` to construct/update the DOM.
 *
 * Invariants (kept from the original single-file implementation):
 * - Background sessions keep streaming when the user switches sessions.
 * - Only the active session controls the send/stop UI.
 * - The request uses a snapshot of the session history taken at send time.
 * - Source URLs are sanitized on arrival (http/https only) before they reach
 *   any anchor, so persisted pills can never carry javascript:/file: links.
 */
import { ChatHistory, chatStream, getSelectedModel, type Source } from './chat.ts'
import { sessionStore } from './sessions.ts'
import { renderMarkdownHighlighted } from './highlight.ts'
import { stripSourcesFromContent } from '../shared/chat.ts'
import { sanitizeSources, createSourcesPill, sourceTitle } from './chat-sources.ts'
import {
  buildReasoning,
  makeDoneRow,
  makeReasoningPillIcon,
  makeStepRow,
  makeToolEntry,
  makeToolRow,
  splitReasoningSteps,
  type ReasoningBuild,
} from './chat-reasoning.ts'
import { appendAssistantArea, appendMessage, createUserBubble, renderPersistedReasoning } from './chat-view.ts'

/**
 * Wire the chat thread, composer actions and per-session streaming.
 * Call once at startup — after the title bar, sidebar, settings and
 * credentials wiring so the chat thread is restored last.
 */
export function wireChat(): void {
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
    reasoning: ReasoningBuild | null
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

  const showError = (msg: string) => {
    appendMessage(column, thread, 'error', msg)
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
    appendMessage(column, thread, 'user', raw)
    history.add('user', raw)
    sessionStore.setMessages(sessionId, history.snapshot())
    field.value = ''
    field.dispatchEvent(new Event('input', { bubbles: true }))
    // Shrink the auto-grow textarea back
    field.style.height = 'auto'
    field.focus()

    const { root: assistantWrap, answerEl } = appendAssistantArea(column, thread)
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
    let reasoning: ReasoningBuild | null = null
    let toolBody: HTMLElement | null = null
    let contentStarted = false
    let anyDelta = false
    const controller = new AbortController()
    abortControllers.set(sessionId, controller)

    // Shiny "thinking" shimmer shown from send until the first delta lands.
    // Static markup only — no interpolated values.
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
    const ensureReasoning = (): ReasoningBuild => {
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
      if (typing) typing.replaceWith(makeReasoningPillIcon())
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
          // Sanitize (http/https only) then merge & dedupe by URL — multiple
          // tool calls may emit incremental lists.
          const seen = new Set(sources.map((s) => s.url))
          for (const s of sanitizeSources(chunk.sources)) {
            if (seen.has(s.url)) continue
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
          column.appendChild(createUserBubble(m.content))
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
        column.appendChild(createUserBubble(m.content))
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
