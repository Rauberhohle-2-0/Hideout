/**
 * Settings panel — provider API keys.
 *
 * Loads the keychain-backed credential states from the sidecar's
 * `/api/credentials` routes (helpers in src/renderer/credentials.ts) and
 * renders one row per provider. The API never returns raw keys — only a
 * masked hint like `sk-...abcd` — so the UI only knows whether a key
 * exists and lets the user add, replace or remove it. A typed key travels
 * once over localhost to the sidecar, which stores it in the OS keychain.
 *
 * Refreshes each time the settings modal opens (hideout:settings-opened,
 * dispatched by wireSettings in ./settings-mcp.ts).
 */
import { deleteCredential, listCredentials, setCredential } from './credentials.ts'
import type { CredentialState } from './credentials.ts'
import { providerLabel } from './settings.ts'

/** Wire the provider credential section inside the settings dialog. */
export function wireCredentials(): void {
  const listEl = document.querySelector<HTMLElement>('#credentials-list')
  const loadingEl = document.querySelector<HTMLElement>('#credentials-loading')
  const errorEl = document.querySelector<HTMLElement>('#credentials-error')
  const retryBtn = document.querySelector<HTMLButtonElement>('#credentials-retry')
  const actionErrorEl = document.querySelector<HTMLElement>('#credentials-action-error')
  if (!listEl || !loadingEl || !errorEl || !retryBtn || !actionErrorEl) return

  const setState = (state: 'loading' | 'error' | 'list') => {
    loadingEl.hidden = state !== 'loading'
    errorEl.hidden = state !== 'error'
    listEl.hidden = state !== 'list'
  }

  const render = (credentials: CredentialState[]) => {
    listEl.replaceChildren(...credentials.map((c) => renderRow(c)))
  }

  const reloadQuiet = async (): Promise<void> => {
    try {
      const { credentials } = await listCredentials()
      render(credentials)
      actionErrorEl.hidden = true
    } catch {
      // Transient failure after an action — keep the current rows.
    }
  }

  const load = async (): Promise<void> => {
    setState('loading')
    actionErrorEl.hidden = true
    try {
      const { credentials } = await listCredentials()
      render(credentials)
      setState('list')
    } catch {
      setState('error')
    }
  }

  retryBtn.addEventListener('click', () => void load())
  window.addEventListener('hideout:settings-opened', () => void load())

  const inputCls =
    'min-w-0 flex-1 rounded-lg border border-line/70 bg-card/80 px-2.5 py-1.5 text-sm text-ink caret-ink outline-none transition-colors duration-150 placeholder:text-dim/60 focus:border-accent/70'

  const renderRow = (state: CredentialState): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'mcp-server-row flex-wrap'
    row.dataset.providerId = state.providerId

    const textCol = document.createElement('div')
    textCol.className = 'flex min-w-0 flex-1 flex-col gap-0.5'
    const name = document.createElement('span')
    name.className = 'truncate text-sm font-medium text-ink'
    name.textContent = providerLabel(state.providerId)
    textCol.appendChild(name)
    const detail = document.createElement('span')
    detail.className = 'truncate text-xs text-dim'
    detail.textContent = state.hasKey && state.maskedKey ? `Key stored — ${state.maskedKey}` : 'No key stored'
    textCol.appendChild(detail)
    row.appendChild(textCol)

    const actions = document.createElement('div')
    actions.className = 'flex shrink-0 items-center gap-2'

    const smallBtn = (label: string, tone: 'neutral' | 'accent' | 'danger'): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      const base = 'inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150'
      if (tone === 'accent') {
        b.className = `${base} border-accent/40 bg-accent/15 text-ink hover:bg-accent/25`
      } else if (tone === 'danger') {
        b.className = `${base} border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/70`
      } else {
        b.className = `${base} border-line/70 bg-card/80 text-dim hover:bg-black/10 hover:text-ink dark:hover:bg-white/10 dark:hover:text-ink`
      }
      b.textContent = label
      return b
    }

    const startEdit = () => {
      row.replaceChildren()
      const input = document.createElement('input')
      input.type = 'password'
      input.autocomplete = 'off'
      input.spellcheck = false
      input.placeholder = state.hasKey ? 'New API key' : 'Paste API key'
      input.className = inputCls
      const saveBtn = smallBtn('Save', 'accent')
      saveBtn.classList.add('font-semibold')
      const cancelBtn = smallBtn('Cancel', 'neutral')
      const errEl = document.createElement('p')
      errEl.className = 'w-full text-xs text-red-600 dark:text-red-400'
      errEl.hidden = true
      row.append(input, saveBtn, cancelBtn, errEl)
      input.focus()
      const commit = async () => {
        const key = input.value.trim()
        if (!key) {
          errEl.textContent = 'API key is required.'
          errEl.hidden = false
          return
        }
        saveBtn.disabled = true
        saveBtn.textContent = 'Saving…'
        try {
          await setCredential(state.providerId, key)
          await reloadQuiet()
        } catch (e) {
          errEl.textContent = e instanceof Error ? e.message : String(e)
          errEl.hidden = false
          saveBtn.disabled = false
          saveBtn.textContent = 'Save'
        }
      }
      saveBtn.addEventListener('click', () => void commit())
      cancelBtn.addEventListener('click', () => void reloadQuiet())
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void commit()
        } else if (e.key === 'Escape') {
          // Cancel the edit instead of closing the whole modal.
          e.preventDefault()
          e.stopPropagation()
          void reloadQuiet()
        }
      })
    }

    if (state.hasKey) {
      const replaceBtn = smallBtn('Replace', 'neutral')
      replaceBtn.addEventListener('click', startEdit)
      const removeBtn = smallBtn('Remove', 'danger')
      removeBtn.addEventListener('click', () => {
        void (async () => {
          try {
            await deleteCredential(state.providerId)
            await reloadQuiet()
          } catch (e) {
            actionErrorEl.textContent = e instanceof Error ? e.message : String(e)
            actionErrorEl.hidden = false
          }
        })()
      })
      actions.append(replaceBtn, removeBtn)
    } else {
      const addBtn = smallBtn('Add key', 'accent')
      addBtn.addEventListener('click', startEdit)
      actions.appendChild(addBtn)
    }
    row.appendChild(actions)
    return row
  }
}
