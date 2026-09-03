/**
 * Settings modal — MCP server management.
 *
 * The gear button in the title bar opens a centered glass dialog (shell in
 * index.html) listing the configured MCP servers with their connection
 * status. User-configured servers can be added, edited and deleted; the
 * code-owned built-in (Exa) is read-only. The forms mirror the shared
 * contract in src/shared/mcp.ts (STDIO → command/args/env, HTTP/SSE →
 * url/headers/timeout) and reuse the renderer helpers in src/renderer/mcp.ts.
 * After a save the server is reconnected so the list reflects a real status
 * instead of a stale "disconnected".
 */
import { connectMcpServer, createMcpServer, deleteMcpServer, listMcpServers, updateMcpServer } from './mcp.ts'
import { kvToObject, slugifyServerId } from './settings.ts'
import { validateMcpServerConfig } from '../shared/mcp.ts'
import type { McpServerConfig, McpServerInfo, McpServerStatus, McpTransport } from '../shared/mcp.ts'
import { hydrateIcons as hydrateRegisteredIcons } from './icons.ts'

/** Wire the settings dialog (list view + transport-specific add/edit form). */
export function wireSettings(): void {
  const button = document.querySelector<HTMLButtonElement>('#settings-button')
  const backdrop = document.querySelector<HTMLElement>('#settings-backdrop')
  const modal = document.querySelector<HTMLElement>('#settings-modal')
  const closeBtn = document.querySelector<HTMLButtonElement>('#settings-close')
  const listView = document.querySelector<HTMLElement>('#mcp-view')
  const listEl = document.querySelector<HTMLElement>('#mcp-list')
  const loadingEl = document.querySelector<HTMLElement>('#mcp-loading')
  const loadErrorEl = document.querySelector<HTMLElement>('#mcp-load-error')
  const retryBtn = document.querySelector<HTMLButtonElement>('#mcp-retry-button')
  const emptyEl = document.querySelector<HTMLElement>('#mcp-empty')
  const listErrorEl = document.querySelector<HTMLElement>('#mcp-list-error')
  const addButton = document.querySelector<HTMLButtonElement>('#mcp-add-button')
  const formView = document.querySelector<HTMLElement>('#mcp-form-view')
  const form = document.querySelector<HTMLFormElement>('#mcp-form')
  const formBack = document.querySelector<HTMLButtonElement>('#mcp-form-back')
  const formTitle = document.querySelector<HTMLElement>('#mcp-form-title')
  const formErrorEl = document.querySelector<HTMLElement>('#mcp-form-error')
  const submitBtn = document.querySelector<HTMLButtonElement>('#mcp-form-submit')
  const submitLabel = document.querySelector<HTMLElement>('#mcp-form-submit-label')
  const fieldsEl = document.querySelector<HTMLElement>('#mcp-form-fields')
  if (
    !button || !backdrop || !modal || !closeBtn || !listView || !listEl ||
    !loadingEl || !loadErrorEl || !retryBtn || !emptyEl || !listErrorEl ||
    !addButton || !formView || !form || !formBack || !formTitle ||
    !formErrorEl || !submitBtn || !submitLabel || !fieldsEl
  ) return

  // Re-hydrate Lucide icons added to the DOM at runtime (the startup pass in
  // bootstrap.ts only covers the static markup in index.html).
  const hydrateIcons = () => hydrateRegisteredIcons(['ChevronLeft', 'Pencil', 'Plus', 'Trash2', 'X'])

  // ── Open / close ──────────────────────────────────────────────────────
  let lastFocused: HTMLElement | null = null

  button.addEventListener('pointerdown', (event) => event.stopPropagation())
  button.addEventListener('click', () => {
    if (backdrop.hidden) openSettings()
  })
  closeBtn.addEventListener('click', () => closeSettings())
  // Clicking the backdrop (not the dialog) dismisses.
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) closeSettings()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !backdrop.hidden) closeSettings()
  })
  // Light focus trap so Tab cycles inside the dialog while it is open.
  modal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    const focusables = Array.from(
      modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hidden && el.getClientRects().length > 0)
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  // The wireSettings helpers are `const` arrows (not hoisted declarations)
  // so TypeScript keeps the narrowing from the null guard above inside them.
  const openSettings = (): void => {
    lastFocused = document.activeElement as HTMLElement | null
    backdrop.hidden = false
    button.setAttribute('aria-expanded', 'true')
    closeBtn.focus()
    showListView()
    void refresh()
    window.dispatchEvent(new CustomEvent('hideout:settings-opened'))
  }

  const closeSettings = (): void => {
    if (backdrop.hidden) return
    backdrop.hidden = true
    button.setAttribute('aria-expanded', 'false')
    lastFocused?.focus()
  }

  // ── Server list ───────────────────────────────────────────────────────
  let servers: McpServerInfo[] = []

  const setListState = (state: 'loading' | 'error' | 'empty' | 'list') => {
    loadingEl.hidden = state !== 'loading'
    loadErrorEl.hidden = state !== 'error'
    emptyEl.hidden = state !== 'empty'
    listEl.hidden = state !== 'list'
  }

  const showListError = (message: string) => {
    listErrorEl.textContent = message
    listErrorEl.hidden = false
  }

  const refresh = async (): Promise<void> => {
    setListState('loading')
    listErrorEl.hidden = true
    try {
      servers = await listMcpServers()
      if (servers.length === 0) {
        setListState('empty')
      } else {
        renderList()
        setListState('list')
      }
    } catch {
      setListState('error')
    }
  }

  const STATUS_LABELS: Record<McpServerStatus, string> = {
    connected: 'Connected',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
    error: 'Error',
  }

  const renderList = (): void => {
    listEl.replaceChildren(...servers.map(renderServerRow))
    hydrateIcons()
  }

  const renderServerRow = (info: McpServerInfo): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'mcp-server-row'
    row.dataset.serverId = info.id

    const textCol = document.createElement('div')
    textCol.className = 'flex min-w-0 flex-1 flex-col gap-1'

    const titleRow = document.createElement('div')
    titleRow.className = 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'
    const name = document.createElement('span')
    name.className = 'truncate text-sm font-medium text-ink'
    name.textContent = info.name
    name.title = info.name
    titleRow.appendChild(name)
    const transportBadge = document.createElement('span')
    transportBadge.className = 'mcp-transport-badge'
    transportBadge.textContent = info.transport
    titleRow.appendChild(transportBadge)
    if (info.builtIn) {
      const builtInBadge = document.createElement('span')
      builtInBadge.className = 'mcp-builtin-badge'
      builtInBadge.textContent = 'Built-in'
      titleRow.appendChild(builtInBadge)
    }
    const statusBadge = document.createElement('span')
    statusBadge.className = `mcp-status-badge is-${info.status}`
    const dot = document.createElement('span')
    dot.className = 'mcp-status-dot'
    dot.setAttribute('aria-hidden', 'true')
    const statusText = document.createElement('span')
    statusText.textContent = STATUS_LABELS[info.status]
    statusBadge.append(dot, statusText)
    titleRow.appendChild(statusBadge)
    textCol.appendChild(titleRow)

    if (info.description) {
      const desc = document.createElement('p')
      desc.className = 'truncate text-xs text-dim'
      desc.textContent = info.description
      desc.title = info.description
      textCol.appendChild(desc)
    }
    if (info.status === 'error' && info.error) {
      const err = document.createElement('p')
      err.className = 'truncate text-xs text-red-600 dark:text-red-400'
      err.textContent = info.error
      err.title = info.error
      textCol.appendChild(err)
    }
    row.appendChild(textCol)

    if (!info.builtIn) {
      const actions = document.createElement('div')
      actions.className = 'mcp-row-actions'
      actions.appendChild(makeActionButton('pencil', `Edit ${info.name}`, () => startEdit(info)))
      actions.appendChild(makeActionButton('trash-2', `Delete ${info.name}`, () => void removeServer(info)))
      row.appendChild(actions)
    }
    return row
  }

  const makeActionButton = (iconName: string, ariaLabel: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'mcp-action'
    b.setAttribute('aria-label', ariaLabel)
    const icon = document.createElement('i')
    icon.className = 'size-3.5'
    icon.setAttribute('data-lucide', iconName)
    b.appendChild(icon)
    b.addEventListener('click', onClick)
    return b
  }

  const removeServer = async (info: McpServerInfo): Promise<void> => {
    // Instant deletion, matching the sidebar chat rows — confirm() is
    // unreliable in WKWebView/Vantail.
    try {
      await deleteMcpServer(info.id)
      listErrorEl.hidden = true
      void refresh()
    } catch (e) {
      showListError(e instanceof Error ? e.message : String(e))
    }
  }

  retryBtn.addEventListener('click', () => void refresh())
  addButton.addEventListener('click', () => showForm('Add MCP server'))
  formBack.addEventListener('click', () => showListView())

  // ── Add / edit form ───────────────────────────────────────────────────
  const fieldInputCls =
    'w-full rounded-lg border border-line/70 bg-card/80 px-2.5 py-1.5 text-sm text-ink caret-ink outline-none transition-colors duration-150 placeholder:text-dim/60 focus:border-accent/70'
  const rowInputCls =
    'min-w-0 flex-1 rounded-lg border border-line/70 bg-card/80 px-2.5 py-1.5 text-sm text-ink caret-ink outline-none transition-colors duration-150 placeholder:text-dim/60 focus:border-accent/70'

  const makeTextInput = (opts: { placeholder?: string; type?: string; cls?: string } = {}): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = opts.type ?? 'text'
    input.className = opts.cls ?? fieldInputCls
    if (opts.placeholder) input.placeholder = opts.placeholder
    return input
  }

  /** Label-wrapped field for single controls. */
  const makeField = (labelText: string, control: HTMLElement, hint?: string): HTMLElement => {
    const wrap = document.createElement('label')
    wrap.className = 'block min-w-0'
    const label = document.createElement('span')
    label.className = 'mb-1 block text-xs font-medium text-dim'
    label.textContent = labelText
    wrap.append(label, control)
    if (hint) {
      const p = document.createElement('p')
      p.className = 'mt-1 text-[11px] leading-relaxed text-dim/80'
      p.textContent = hint
      wrap.appendChild(p)
    }
    return wrap
  }

  /** Group with its own heading, for fields that hold lists of rows. */
  const makeGroup = (labelText: string, content: HTMLElement, hint?: string): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'min-w-0'
    const label = document.createElement('span')
    label.className = 'mb-1 block text-xs font-medium text-dim'
    label.textContent = labelText
    wrap.append(label, content)
    if (hint) {
      const p = document.createElement('p')
      p.className = 'mt-1 text-[11px] leading-relaxed text-dim/80'
      p.textContent = hint
      wrap.appendChild(p)
    }
    return wrap
  }

  const makeAddRowButton = (labelText: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className =
      'inline-flex h-7 items-center gap-1 self-start rounded-full border border-line/70 bg-card/80 px-2.5 text-[11px] font-medium text-dim transition-colors duration-150 hover:bg-black/10 hover:text-ink active:bg-black/15 dark:hover:bg-white/10 dark:hover:text-ink dark:active:bg-white/15'
    const icon = document.createElement('i')
    icon.className = 'size-3'
    icon.setAttribute('data-lucide', 'plus')
    b.appendChild(icon)
    const span = document.createElement('span')
    span.textContent = labelText
    b.appendChild(span)
    b.addEventListener('click', onClick)
    return b
  }

  const makeRemoveButton = (ariaLabel: string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className =
      'grid size-6 shrink-0 place-items-center rounded-full text-dim transition-colors duration-150 hover:bg-black/10 hover:text-ink active:bg-black/15 dark:hover:bg-white/10 dark:hover:text-ink dark:active:bg-white/15'
    b.setAttribute('aria-label', ariaLabel)
    const icon = document.createElement('i')
    icon.className = 'size-3'
    icon.setAttribute('data-lucide', 'x')
    b.appendChild(icon)
    return b
  }

  // Shared fields: name, id, description, enabled.
  const nameInput = makeTextInput({ placeholder: 'e.g. Filesystem server' })
  const idInput = makeTextInput({ placeholder: 'e.g. filesystem' })
  const descriptionInput = makeTextInput({ placeholder: 'Optional description' })

  const enabledCheckbox = document.createElement('input')
  enabledCheckbox.type = 'checkbox'
  enabledCheckbox.className = 'sr-only'
  enabledCheckbox.checked = true
  const enabledSwitch = document.createElement('span')
  enabledSwitch.className = 'switch'
  const enabledText = document.createElement('span')
  enabledText.className = 'text-sm font-medium text-ink'
  enabledText.textContent = 'Enabled'
  const enabledControl = document.createElement('label')
  enabledControl.className = 'flex cursor-pointer select-none items-center gap-2.5'
  enabledControl.append(enabledCheckbox, enabledSwitch, enabledText)
  const enabledRow = document.createElement('div')
  enabledRow.className = 'flex items-center justify-between gap-3'
  const enabledLabel = document.createElement('span')
  enabledLabel.className = 'text-xs font-medium text-dim'
  enabledLabel.textContent = 'Expose this server’s tools to the chat'
  enabledRow.append(enabledLabel, enabledControl)

  // Suggest the id from the name until the user edits the id themselves.
  let idTouched = false
  nameInput.addEventListener('input', () => {
    if (!idTouched) idInput.value = slugifyServerId(nameInput.value)
  })
  idInput.addEventListener('input', () => {
    idTouched = true
  })

  // Transport selector (segmented control in the app's pill language).
  const TRANSPORTS: Array<{ id: McpTransport; label: string }> = [
    { id: 'stdio', label: 'STDIO' },
    { id: 'http', label: 'HTTP' },
    { id: 'sse', label: 'SSE' },
  ]
  let transport: McpTransport = 'http'
  let editingId: string | null = null
  const transportSegments: HTMLButtonElement[] = []
  const transportSelector = document.createElement('div')
  transportSelector.className = 'inline-flex items-center gap-1 rounded-full border border-line/70 bg-card/80 p-1'
  for (const t of TRANSPORTS) {
    const seg = document.createElement('button')
    seg.type = 'button'
    seg.dataset.transport = t.id
    seg.className = 'rounded-full px-3.5 py-1 text-xs font-medium transition-colors duration-150'
    seg.textContent = t.label
    seg.addEventListener('click', () => {
      transport = t.id
      renderTransport()
    })
    transportSegments.push(seg)
    transportSelector.appendChild(seg)
  }

  // STDIO fields: command, args, env, cwd.
  const commandInput = makeTextInput({ placeholder: 'e.g. npx' })
  const argsList = document.createElement('div')
  argsList.className = 'flex flex-col gap-2'
  const argsRows: HTMLInputElement[] = []
  const addArgRow = (value = '') => {
    const wrap = document.createElement('div')
    wrap.className = 'flex items-center gap-2'
    const input = makeTextInput({
      placeholder: 'e.g. -y @modelcontextprotocol/server-filesystem',
      cls: rowInputCls,
    })
    input.value = value
    const remove = makeRemoveButton('Remove argument')
    remove.addEventListener('click', () => {
      wrap.remove()
      const idx = argsRows.indexOf(input)
      if (idx >= 0) argsRows.splice(idx, 1)
    })
    wrap.append(input, remove)
    argsList.appendChild(wrap)
    argsRows.push(input)
    hydrateIcons()
  }
  const argsBox = document.createElement('div')
  argsBox.className = 'flex flex-col gap-2'
  argsBox.append(argsList, makeAddRowButton('Add argument', () => addArgRow()))

  const cwdInput = makeTextInput({ placeholder: 'e.g. /Users/me/project' })

  type KvRow = { keyInput: HTMLInputElement; valueInput: HTMLInputElement; el: HTMLElement }
  const makeKvRow = (
    rows: KvRow[],
    container: HTMLElement,
    keyPh: string,
    valuePh: string,
  ): KvRow => {
    const el = document.createElement('div')
    el.className = 'flex items-center gap-2'
    const keyInput = makeTextInput({ placeholder: keyPh, cls: rowInputCls })
    const valueInput = makeTextInput({ placeholder: valuePh, cls: rowInputCls })
    const remove = makeRemoveButton('Remove row')
    const row: KvRow = { keyInput, valueInput, el }
    remove.addEventListener('click', () => {
      el.remove()
      const idx = rows.indexOf(row)
      if (idx >= 0) rows.splice(idx, 1)
    })
    el.append(keyInput, valueInput, remove)
    container.appendChild(el)
    rows.push(row)
    hydrateIcons()
    return row
  }

  const envList = document.createElement('div')
  envList.className = 'flex flex-col gap-2'
  const envRows: KvRow[] = []
  const envBox = document.createElement('div')
  envBox.className = 'flex flex-col gap-2'
  envBox.append(envList, makeAddRowButton('Add variable', () => makeKvRow(envRows, envList, 'e.g. FOO', 'e.g. bar')))

  const stdioGroup = document.createElement('div')
  stdioGroup.className = 'flex flex-col gap-4'
  stdioGroup.append(
    makeField('Command', commandInput, 'Executable that starts the server — e.g. npx, uvx, node.'),
    makeGroup('Arguments', argsBox, 'One argument per row, in order.'),
    makeGroup('Environment variables', envBox, 'Optional variables injected into the process.'),
    makeField('Working directory', cwdInput, 'Optional directory the command runs in.'),
  )

  // HTTP/SSE fields: url, headers, timeout.
  const urlInput = makeTextInput({ placeholder: 'https://mcp.example.com/mcp' })
  const headerList = document.createElement('div')
  headerList.className = 'flex flex-col gap-2'
  const headerRows: KvRow[] = []
  const headersBox = document.createElement('div')
  headersBox.className = 'flex flex-col gap-2'
  headersBox.append(headerList, makeAddRowButton('Add header', () => makeKvRow(headerRows, headerList, 'e.g. Authorization', 'e.g. Bearer …')))
  const timeoutInput = makeTextInput({ type: 'number', placeholder: '30' })
  timeoutInput.min = '1'
  timeoutInput.max = '600'

  const httpGroup = document.createElement('div')
  httpGroup.className = 'flex flex-col gap-4'
  httpGroup.append(
    makeField('Endpoint URL', urlInput, 'Remote Streamable HTTP (or legacy SSE) endpoint.'),
    makeGroup('Headers', headersBox, 'Optional request headers, e.g. Authorization.'),
    makeField('Timeout (seconds)', timeoutInput, 'Defaults to 30.'),
  )

  fieldsEl.append(
    makeField('Name', nameInput),
    makeField('ID', idInput, 'Lowercase letters, numbers, - or _ (2–31 chars).'),
    makeField('Description', descriptionInput),
    enabledRow,
    makeGroup('Transport', transportSelector),
    stdioGroup,
    httpGroup,
  )
  hydrateIcons()

  const renderTransport = (): void => {
    for (const seg of transportSegments) {
      const active = seg.dataset.transport === transport
      seg.classList.toggle('bg-accent/15', active)
      seg.classList.toggle('text-ink', active)
      seg.classList.toggle('text-dim', !active)
      seg.classList.toggle('hover:text-ink', !active)
      seg.setAttribute('aria-pressed', String(active))
    }
    stdioGroup.hidden = transport !== 'stdio'
    httpGroup.hidden = transport === 'stdio'
  }

  const clearRows = (container: HTMLElement, rows: Array<HTMLInputElement | KvRow>): void => {
    rows.length = 0
    container.replaceChildren()
  }

  const showForm = (title: string, prefill?: McpServerInfo): void => {
    listView.hidden = true
    formView.hidden = false
    formTitle.textContent = title
    formErrorEl.hidden = true
    submitBtn.disabled = false
    submitLabel.textContent = prefill ? 'Save changes' : 'Add server'
    editingId = prefill?.id ?? null
    idTouched = Boolean(prefill)
    nameInput.value = prefill?.name ?? ''
    idInput.value = prefill?.id ?? ''
    idInput.disabled = Boolean(prefill)
    descriptionInput.value = prefill?.description ?? ''
    enabledCheckbox.checked = prefill?.enabled ?? true

    const isStdio = prefill?.transport === 'stdio'
    transport = prefill?.transport ?? 'http'
    commandInput.value = isStdio && prefill ? prefill.command : ''
    cwdInput.value = isStdio && prefill ? (prefill.cwd ?? '') : ''
    urlInput.value = isStdio || !prefill ? '' : prefill.url
    timeoutInput.value = isStdio || !prefill ? '' : String(prefill.timeout ?? 30)

    clearRows(argsList, argsRows)
    if (isStdio && prefill?.args) {
      for (const a of prefill.args) addArgRow(a)
    } else {
      addArgRow()
    }
    clearRows(envList, envRows)
    if (isStdio && prefill?.env) {
      for (const [k, v] of Object.entries(prefill.env)) {
        const row = makeKvRow(envRows, envList, 'e.g. FOO', 'e.g. bar')
        row.keyInput.value = k
        row.valueInput.value = v
      }
    }
    clearRows(headerList, headerRows)
    if (!isStdio && prefill?.headers) {
      for (const [k, v] of Object.entries(prefill.headers)) {
        const row = makeKvRow(headerRows, headerList, 'e.g. Authorization', 'e.g. Bearer …')
        row.keyInput.value = k
        row.valueInput.value = v
      }
    }
    renderTransport()
    hydrateIcons()
    nameInput.focus()
  }

  const showFormError = (message: string): void => {
    formErrorEl.textContent = message
    formErrorEl.hidden = false
  }

  const showListView = (): void => {
    listView.hidden = false
    formView.hidden = true
    formErrorEl.hidden = true
  }

  const startEdit = (info: McpServerInfo): void => {
    showForm(`Edit “${info.name}”`, info)
  }

  const buildConfig = (): McpServerConfig | null => {
    const name = nameInput.value.trim()
    const id = idInput.value.trim().toLowerCase()
    if (!name) {
      showFormError('Name is required.')
      return null
    }
    if (!id) {
      showFormError('ID is required.')
      return null
    }
    const base = {
      id,
      name,
      enabled: enabledCheckbox.checked,
      ...(descriptionInput.value.trim() ? { description: descriptionInput.value.trim() } : {}),
    }
    if (transport === 'stdio') {
      const command = commandInput.value.trim()
      if (!command) {
        showFormError('Command is required for STDIO transport.')
        return null
      }
      const args = argsRows.map((r) => r.value.trim()).filter(Boolean)
      const env = kvToObject(envRows.map((r) => ({ key: r.keyInput.value, value: r.valueInput.value })))
      const cwd = cwdInput.value.trim()
      return {
        ...base,
        transport: 'stdio',
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(cwd ? { cwd } : {}),
      } as McpServerConfig
    }
    const url = urlInput.value.trim()
    if (!url) {
      showFormError(`URL is required for ${transport.toUpperCase()} transport.`)
      return null
    }
    const headers = kvToObject(headerRows.map((r) => ({ key: r.keyInput.value, value: r.valueInput.value })))
    const parsedTimeout = Number(timeoutInput.value)
    return {
      ...base,
      transport: transport === 'sse' ? 'sse' : 'http',
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? { timeout: parsedTimeout } : {}),
    } as McpServerConfig
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void saveServer()
  })

  const saveServer = async (): Promise<void> => {
    const config = buildConfig()
    if (!config) return
    const validationError = validateMcpServerConfig(config)
    if (validationError) {
      showFormError(validationError)
      return
    }
    setSubmitting(true)
    try {
      if (editingId) await updateMcpServer(editingId, config)
      else await createMcpServer(config)
      showListView()
      void refresh()
      // Reconnect so the list shows a real status instead of a stale
      // "disconnected"; the follow-up refresh lands the final state.
      if (config.enabled !== false) {
        void connectMcpServer(config.id)
          .then(() => refresh())
          .catch(() => refresh())
      }
    } catch (e) {
      showFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const setSubmitting = (submitting: boolean): void => {
    submitBtn.disabled = submitting
    submitBtn.setAttribute('aria-busy', String(submitting))
    submitLabel.textContent = submitting ? 'Saving…' : editingId ? 'Save changes' : 'Add server'
  }

  renderTransport()
}
