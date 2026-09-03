/**
 * Renderer privacy mode — the opt-in “do not save chat history” setting.
 *
 * When enabled, newly created chats are marked `ephemeral` (see
 * `sessionStore.setEphemeralDefault`) and never written to localStorage:
 * they exist only in memory and are gone when the window closes. Previously
 * saved chats are left untouched — enabling the mode never destroys data.
 *
 * The choice itself persists in localStorage (`hideout.privacy.ephemeralChats`),
 * so it survives restarts, and is applied before the chat restore path runs.
 */
import { sessionStore } from './sessions.ts'

export const EPHEMERAL_CHATS_KEY = 'hideout.privacy.ephemeralChats'

/** Whether the privacy mode is currently on. */
export function isEphemeralChatsEnabled(): boolean {
  try {
    return localStorage.getItem(EPHEMERAL_CHATS_KEY) === '1'
  } catch {
    return false
  }
}

/** Apply the persisted choice to the session store (call once at boot). */
export function applyStoredEphemeralMode(): void {
  sessionStore.setEphemeralDefault(isEphemeralChatsEnabled())
}

/** Turn the mode on/off and persist the choice. */
export function setEphemeralChatsEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(EPHEMERAL_CHATS_KEY, '1')
    else localStorage.removeItem(EPHEMERAL_CHATS_KEY)
  } catch {
    // No storage — the mode still applies for this window's lifetime.
  }
  sessionStore.setEphemeralDefault(on)
}
