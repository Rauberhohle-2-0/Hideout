/**
 * Composer controls — textarea auto-grow and the per-chat MCP/tools toggle.
 *
 * The composer field's height tracks its scrollHeight on every input so the
 * pill grows line by line instead of clipping long messages. The wrench
 * button (`#tools-toggle`) toggles whether MCP/tools are exposed for the
 * current chat; state lives per-session in `sessionStore` (`toolsEnabled`,
 * defaults to true).
 */
import { sessionStore } from './sessions.ts'

/**
 * Auto-grow the chat composer's textarea with its content.
 *
 * Growth stops at exactly four lines of text (or 40% of the window height on
 * smaller windows); past it, the textarea scrolls instead of growing, so the
 * bar stays compact and the line being typed is never cut off.
 */
export function wireComposer(): void {
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
 * Visual: `aria-pressed` + `tools-enabled` / `tools-disabled` + accent bg
 * when enabled, dimmed when disabled. Updates on session change and on click.
 */
export function wireToolsToggle(): void {
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
