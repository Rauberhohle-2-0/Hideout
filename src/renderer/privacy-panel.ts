/**
 * Settings wiring — chat-history privacy section.
 *
 * A single opt-in switch: “Do not save chat history”. Turning it on makes
 * new chats ephemeral (in-memory only) without touching previously saved
 * conversations. The section is static markup in index.html
 * (`#privacy-section`); this module binds the switch and the explanatory
 * note that reflects the current state.
 */
import { isEphemeralChatsEnabled, setEphemeralChatsEnabled } from './privacy.ts'

export function wirePrivacyPanel(): void {
  const checkbox = document.querySelector<HTMLInputElement>('#privacy-ephemeral-checkbox')
  const stateNote = document.querySelector<HTMLElement>('#privacy-state-note')
  if (!checkbox || !stateNote) return

  const render = (on: boolean): void => {
    checkbox.checked = on
    stateNote.hidden = !on
    if (on) {
      stateNote.textContent =
        'Ephemeral chats on — conversations started from now on stay only in memory ' +
        'and disappear when you close the window. Previously saved chats are left as they are.'
    }
  }

  checkbox.addEventListener('change', () => {
    setEphemeralChatsEnabled(checkbox.checked)
    render(checkbox.checked)
  })

  render(isEphemeralChatsEnabled())
}
