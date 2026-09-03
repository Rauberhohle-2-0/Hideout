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
import { approveMcpServer, connectMcpServer, createMcpServer, deleteMcpServer, getMcpServerAudit, listMcpServers, revokeMcpApproval, updateMcpServer } from './mcp.ts'
import { kvToObject, slugifyServerId } from './settings.ts'
import { validateMcpServerConfig } from '../shared/mcp.ts'
import type { McpAuditEvent, McpAuditEventType, McpServerConfig, McpServerInfo, McpServerStatus, McpTransport } from '../shared/mcp.ts'
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
    'needs-approval': 'Needs approval',
  }

  const renderList = (): void => {
    listEl.replaceChildren(...servers.map(renderServerItem))
    hydrateIcons()
  }

  // ── Server details (capabilities + audit trail) ───────────────────────

  /** Human label per audit event type. */
  const AUDIT_LABELS: Record<McpAuditEventType, string> = {
    approve: 'Approved to run locally',
    revoke: 'Approval revoked',
    relock: 'Approval reset',
    network: 'Network policy',
    deleted: 'Server deleted',
  }

  /** Fresh audit events per server id, so re-renders don't refetch. */
  const auditCache = new Map<string, McpAuditEvent[]>()

  /**
   * Column wrapper: the action row plus a collapsible capabilities/audit
   * panel underneath. Built-in servers have no panel (nothing user-managed).
   */
  const renderServerItem = (info: McpServerInfo): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'mcp-server-item'
    const row = renderServerRow(info)
    wrap.appendChild(row)
    if (info.builtIn) return wrap

    const details = buildDetailsShell(info)
    wrap.appendChild(details)
    const toggle = row.querySelector<HTMLButtonElement>('[data-details-toggle]')
    if (toggle) {
      toggle.addEventListener('click', () => {
        const wasHidden = details.hidden
        details.hidden = !wasHidden
        toggle.setAttribute('aria-expanded', String(wasHidden))
        toggle.classList.toggle('is-open', wasHidden === true)
        // Load the audit trail on first open (subsequent opens use the cache).
        if (wasHidden) void loadDetails(info.id, details)
      })
    }
    return wrap
  }

  /** A labelled value line inside a details panel. */
  const makeDetailRow = (label: string, value: string, tone: 'default' | 'warn' | 'ok' = 'default'): HTMLElement => {
    const rowEl = document.createElement('div')
    rowEl.className = 'flex items-baseline justify-between gap-3'
    const dt = document.createElement('span')
    dt.className = 'shrink-0 text-[11px] font-medium text-dim'
    dt.textContent = label
    const dd = document.createElement('span')
    dd.className =
      tone === 'warn'
        ? 'min-w-0 text-right text-[11px] leading-relaxed text-amber-700 dark:text-amber-400'
        : tone === 'ok'
          ? 'min-w-0 text-right text-[11px] font-medium leading-relaxed text-emerald-700 dark:text-emerald-400'
          : 'min-w-0 text-right text-[11px] leading-relaxed text-ink/90'
    dd.textContent = value
    rowEl.append(dt, dd)
    return rowEl
  }

  const makeDetailsSection = (title: string, rows: HTMLElement[]): HTMLElement => {
    const sec = document.createElement('div')
    sec.className = 'flex flex-col gap-1.5'
    const h = document.createElement('h4')
    h.className = 'text-[11px] font-semibold uppercase tracking-wide text-dim/80'
    h.textContent = title
    sec.appendChild(h)
    for (const r of rows) sec.appendChild(r)
    return sec
  }

  /**
   * Capabilities disclosure. For STDIO this is what running the local program
   * actually grants (file access under the user account, minimal env, no
   * network sandbox); for HTTP/SSE it reflects the enforced sidecar policy.
   */
  const buildDetailsShell = (info: McpServerInfo): HTMLElement => {
    const shell = document.createElement('div')
    shell.className = 'mcp-server-details'
    shell.hidden = true
    shell.dataset.serverDetails = info.id

    const capRows: HTMLElement[] = []
    if (info.transport === 'stdio') {
      const s = info as McpServerInfo & { command: string; args?: string[]; cwd?: string }
      const cmd = [s.command, ...(s.args ?? [])].filter(Boolean).join(' ')
      capRows.push(makeDetailRow('Runs', cmd, 'default'))
      if (s.cwd) capRows.push(makeDetailRow('Working directory', s.cwd, 'default'))
      capRows.push(makeDetailRow('File access', 'Full — your user permissions, anywhere you can read or write', 'warn'))
      capRows.push(makeDetailRow('Environment', 'Minimal — standard variables plus the ones configured for this server', 'default'))
      capRows.push(makeDetailRow('Network', 'Not restricted — the process can reach any host (no sandbox)', 'warn'))
      capRows.push(
        makeDetailRow(
          'Trust',
          info.status === 'needs-approval' ? 'Not approved — cannot start' : 'Approved — starts when you connect it',
          info.status === 'needs-approval' ? 'warn' : 'ok',
        ),
      )
    } else {
      const r = info as McpServerInfo & { url: string; timeout?: number; headers?: Record<string, string> }
      const allowed = (info as { privateNetworkAllowed?: boolean }).privateNetworkAllowed === true
      capRows.push(makeDetailRow('Endpoint', r.url, 'default'))
      capRows.push(
        makeDetailRow('Network policy', allowed ? 'Local & private networks allowed' : 'Public internet only', allowed ? 'warn' : 'default'),
      )
      if (allowed) {
        capRows.push(
          makeDetailRow('Reach', 'Can access localhost, your LAN and cloud-metadata endpoints', 'warn'),
        )
      }
      const headerCount = r.headers ? Object.keys(r.headers).length : 0
      capRows.push(
        makeDetailRow('Headers', headerCount > 0 ? `${headerCount} configured — values stay masked` : 'None', 'default'),
      )
      capRows.push(makeDetailRow('Timeout', `${r.timeout ?? 30}s`, 'default'))
    }
    shell.appendChild(makeDetailsSection('What this server can do', capRows))

    // Audit trail loads on first expand.
    const auditTitle = document.createElement('div')
    auditTitle.className = 'mt-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim/80'
    const auditIcon = document.createElement('i')
    auditIcon.className = 'size-3.5'
    auditIcon.setAttribute('data-lucide', 'history')
    const auditLabel = document.createElement('span')
    auditLabel.textContent = 'Trust & policy history'
    auditTitle.append(auditIcon, auditLabel)
    const auditBody = document.createElement('div')
    auditBody.className = 'mt-1.5'
    auditBody.dataset.auditBody = info.id
    auditBody.textContent = 'Loading…'
    shell.append(auditTitle, auditBody)
    return shell
  }

  const loadDetails = async (id: string, shell: HTMLElement): Promise<void> => {
    const body = shell.querySelector<HTMLElement>('[data-audit-body]')
    if (!body) return
    let events: McpAuditEvent[]
    try {
      if (!auditCache.has(id)) {
        auditCache.set(id, await getMcpServerAudit(id))
      }
      events = auditCache.get(id) ?? []
    } catch {
      body.textContent = 'Could not load history.'
      return
    }
    if (events.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'text-[11px] leading-relaxed text-dim/70'
      empty.textContent = 'No trust or policy changes yet — approvals and network-policy changes will appear here.'
      body.replaceChildren(empty)
      return
    }
    const list = document.createElement('ol')
    list.className = 'flex flex-col gap-1.5'
    // Newest first.
    const sorted = [...events].sort((a, b) => b.at - a.at)
    for (const ev of sorted) {
      const li = document.createElement('li')
      li.className = 'flex items-baseline justify-between gap-3'
      const left = document.createElement('span')
      left.className = 'flex min-w-0 flex-col gap-0.5'
      const label = document.createElement('span')
      label.className =
        ev.type === 'approve'
          ? 'truncate text-[11px] font-medium text-emerald-700 dark:text-emerald-400'
          : ev.type === 'revoke' || ev.type === 'relock'
            ? 'truncate text-[11px] font-medium text-amber-700 dark:text-amber-400'
            : 'truncate text-[11px] font-medium text-ink'
      label.textContent = AUDIT_LABELS[ev.type]
      const detail = document.createElement('span')
      detail.className = 'truncate text-[11px] text-dim/90'
      detail.textContent = ev.detail
      detail.title = ev.detail
      left.append(label, detail)
      const when = document.createElement('time')
      when.className = 'shrink-0 text-[10px] text-dim/70'
      when.dateTime = new Date(ev.at).toISOString()
      when.textContent = new Date(ev.at).toLocaleString()
      li.append(left, when)
      list.appendChild(li)
    }
    body.replaceChildren(list)
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
    if (info.status === 'needs-approval') {
      // Unapproved STDIO server: it must never silently start, so surface the
      // risk next to the reason it is paused.
      const warn = document.createElement('p')
      warn.className = 'flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400'
      const icon = document.createElement('i')
      icon.className = 'mt-0.5 size-3.5 shrink-0'
      icon.setAttribute('data-lucide', 'triangle-alert')
      const span = document.createElement('span')
      span.textContent = info.error ??
        `“${info.name}” runs a local program on your machine and has not been approved yet.`
      warn.append(icon, span)
      textCol.appendChild(warn)
    }
    row.appendChild(textCol)
    // Trust & network policy — user-configured servers only. Built-ins (Exa)
    // are code-owned and not user-managed.
    if (!info.builtIn) {
      if (info.transport === 'stdio') {
        if (info.status === 'needs-approval') {
          // Primary action stays visible, not tucked behind the hover actions.
          row.appendChild(makeApproveButton(info))
        } else {
          textCol.appendChild(makeApprovedIndicator(info))
        }
      } else {
        textCol.appendChild(makeNetworkPolicyControl(info))
      }
      const actions = document.createElement('div')
      actions.className = 'mcp-row-actions'
      if (info.transport === 'stdio' && info.status !== 'needs-approval') {
        // Withdraw trust without deleting the server (visible, like approve).
        const revokeBtn = makeActionButton('shield-off', `Revoke approval for ${info.name}`, () => void revokeServerApproval(info))
        revokeBtn.title =
          `Stop trusting “${info.name}”. Its local program is stopped and must be ` +
          'approved again before it can start.'
        row.appendChild(revokeBtn)
      }
      const detailsBtn = makeActionButton('chevron-down', `Server details for ${info.name}`, () => {})
      detailsBtn.dataset.detailsToggle = 'true'
      detailsBtn.setAttribute('aria-expanded', 'false')
      detailsBtn.classList.add('details-toggle')
      detailsBtn.title = 'Capabilities & trust history'
      actions.appendChild(detailsBtn)
      actions.appendChild(makeActionButton('pencil', `Edit ${info.name}`, () => startEdit(info)))
      actions.appendChild(makeActionButton('trash-2', `Delete ${info.name}`, () => void removeServer(info)))
      row.appendChild(actions)
    }
    return row
  }

  /**
   * “Approve & start” — the explicit trust action for a STDIO server. Clicking
   * it records the approval (pinned to the current command/args/cwd), then
   * connects so the local program actually starts while the user is watching.
   */
  const makeApproveButton = (info: McpServerInfo): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className =
      'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 text-[11px] font-semibold text-amber-700 transition-colors duration-150 hover:bg-amber-500/25 active:bg-amber-500/30 dark:text-amber-400'
    const icon = document.createElement('i')
    icon.className = 'size-3'
    icon.setAttribute('data-lucide', 'shield-check')
    b.appendChild(icon)
    const label = document.createElement('span')
    label.textContent = 'Approve & start'
    b.appendChild(label)
    b.title =
      `“${info.name}” runs a local program on your machine with your user permissions. ` +
      'Approve it to record your trust and start the server.'
    b.addEventListener('click', () => void approveAndStart(info))
    return b
  }

  const approveAndStart = async (info: McpServerInfo): Promise<void> => {
    listErrorEl.hidden = true
    try {
      await approveMcpServer(info.id)
      // Recording the approval only un-pauses the server; connect is what
      // spawns the local program, so run it as part of the same explicit act.
      if (info.enabled !== false) {
        await connectMcpServer(info.id)
      }
      void refresh()
    } catch (e) {
      showListError(e instanceof Error ? e.message : String(e))
      void refresh()
    }
  }

  /** Withdraw an approval from the list (server config stays intact). */
  const revokeServerApproval = async (info: McpServerInfo): Promise<void> => {
    listErrorEl.hidden = true
    try {
      await revokeMcpApproval(info.id)
      void refresh()
    } catch (e) {
      showListError(e instanceof Error ? e.message : String(e))
      void refresh()
    }
  }

  /** Trust line under an approved STDIO row: the exact program that runs. */
  const makeApprovedIndicator = (info: McpServerInfo): HTMLElement => {
    const p = document.createElement('p')
    const s = info as McpServerInfo & { command: string; args?: string[] }
    const cmd = [s.command, ...(s.args ?? [])].filter(Boolean).join(' ')
    p.className = 'truncate text-[11px] text-dim/80'
    p.textContent = `Trusted to run locally — ${cmd}`
    p.title = `This server runs “${cmd}” on your machine with your user permissions. Use the shield-off button to withdraw trust.`
    return p
  }

  /**
   * Row-level SSRF-policy switch for HTTP/SSE servers. Off = the sidecar
   * blocks loopback/LAN/cloud-metadata destinations (default); on = the
   * server may reach them. Turning it on saves via PUT (secrets preserved
   * server-side) and reconnects so the new policy takes effect immediately.
   */
  const makeNetworkPolicyControl = (info: McpServerInfo): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'flex flex-col gap-1'
    const labelEl = document.createElement('label')
    labelEl.className = 'flex w-fit cursor-pointer select-none items-center gap-2'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'sr-only'
    checkbox.checked = (info as { privateNetworkAllowed?: boolean }).privateNetworkAllowed === true
    const switchEl = document.createElement('span')
    switchEl.className = 'switch'
    const stateText = document.createElement('span')
    stateText.className = 'text-[11px] font-medium text-dim'
    const hintEl = document.createElement('p')
    hintEl.className = 'text-[11px] leading-relaxed text-dim/70'
    const applyCopy = (allowed: boolean): void => {
      stateText.textContent = allowed ? 'Local & private networks allowed' : 'Internet only'
      hintEl.textContent = allowed
        ? 'This server may reach localhost, your LAN and cloud-metadata endpoints — only enable it if you trust the server.'
        : 'Localhost, LAN and cloud-metadata addresses are blocked by the SSRF guard. Enable only for servers you trust, e.g. one running on this machine.'
    }
    applyCopy(checkbox.checked)
    labelEl.append(checkbox, switchEl, stateText)
    wrap.append(labelEl, hintEl)
    checkbox.addEventListener('change', () => {
      applyCopy(checkbox.checked)
      void setNetworkPolicy(info, checkbox.checked)
    })
    return wrap
  }

  /** PUT the flipped private-network flag (masked secrets are preserved route-side). */
  const setNetworkPolicy = async (info: McpServerInfo, allow: boolean): Promise<void> => {
    listErrorEl.hidden = true
    const remote = info as McpServerInfo & {
      url: string
      headers?: Record<string, string>
      timeout?: number
    }
    const updated = {
      id: info.id,
      name: info.name,
      enabled: info.enabled ?? true,
      transport: remote.transport === 'sse' ? 'sse' : 'http',
      url: remote.url,
      ...(info.description ? { description: info.description } : {}),
      ...(remote.headers && Object.keys(remote.headers).length > 0 ? { headers: remote.headers } : {}),
      ...(typeof remote.timeout === 'number' ? { timeout: remote.timeout } : {}),
      ...(allow ? { privateNetworkAllowed: true } : {}),
    } as McpServerConfig
    try {
      await updateMcpServer(info.id, updated)
      // Reconnect so a blocked server can actually reach its local endpoint
      // (and a formerly-allowed one re-checks the new, stricter policy).
      if (allow && info.enabled !== false) {
        await connectMcpServer(info.id).catch(() => {})
      }
      void refresh()
    } catch (e) {
      showListError(e instanceof Error ? e.message : String(e))
      void refresh()
    }
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

  const stdioWarning = document.createElement('div')
  stdioWarning.className = 'flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400'
  const stdioWarnIcon = document.createElement('i')
  stdioWarnIcon.className = 'mt-0.5 size-3.5 shrink-0'
  stdioWarnIcon.setAttribute('data-lucide', 'triangle-alert')
  const stdioWarnText = document.createElement('span')
  stdioWarnText.textContent =
    'STDIO servers run a local program on your machine with your user permissions — they can ' +
    'read and write files, reach the network, and execute commands. Only add servers you trust; ' +
    'each server must be explicitly approved from the list before it can start.'
  stdioWarning.append(stdioWarnIcon, stdioWarnText)

  const stdioGroup = document.createElement('div')
  stdioGroup.className = 'flex flex-col gap-4'
  stdioGroup.append(
    stdioWarning,
    makeField('Command', commandInput, 'Executable that starts the server — e.g. npx, uvx, node. The process runs with a minimal environment: only standard variables plus the ones you list below.'),
    makeGroup('Arguments', argsBox, 'One argument per row, in order.'),
    makeGroup('Environment variables', envBox, 'Optional variables injected into the process. Values are masked after saving — leave a mask (••••abcd) untouched to keep the stored value, or type a new one to replace it.'),
    makeField('Working directory', cwdInput, 'Optional directory the command runs in.'),
    // Secret values (env vars, auth headers) are masked in this app's server
    // responses since v0.2.0. Editing a stored server shows the mask
    // (`••••abcd`); saving with a mask in place keeps the stored raw value.
    // Type a real value to replace it, or remove the row to delete it.
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

  // SSRF-policy opt-in for remote transports: private/local destinations are
  // blocked unless the user explicitly allows them here.
  const privateNetworkCheckbox = document.createElement('input')
  privateNetworkCheckbox.type = 'checkbox'
  privateNetworkCheckbox.id = 'mcp-private-network'
  privateNetworkCheckbox.className = 'sr-only'
  privateNetworkCheckbox.checked = false
  const privateNetworkSwitch = document.createElement('span')
  privateNetworkSwitch.className = 'switch'
  const privateNetworkSwitchText = document.createElement('span')
  privateNetworkSwitchText.className = 'text-sm font-medium text-ink'
  privateNetworkSwitchText.textContent = 'Allow connections to local & private networks'
  const privateNetworkLabel = document.createElement('label')
  privateNetworkLabel.className = 'flex cursor-pointer select-none items-center gap-2.5'
  privateNetworkLabel.append(privateNetworkCheckbox, privateNetworkSwitch, privateNetworkSwitchText)
  const privateNetworkField = document.createElement('div')
  privateNetworkField.className = 'min-w-0'
  const privateNetworkFieldLabel = document.createElement('span')
  privateNetworkFieldLabel.className = 'mb-1 block text-xs font-medium text-dim'
  privateNetworkFieldLabel.textContent = 'Network access'
  const privateNetworkHint = document.createElement('p')
  privateNetworkHint.className = 'mt-1 text-[11px] leading-relaxed text-dim/80'
  privateNetworkHint.textContent =
    'Off by default: localhost, LAN and cloud-metadata addresses are blocked by the SSRF guard. ' +
    'Turn this on only for servers you trust, e.g. an MCP server running on this machine.'
  privateNetworkField.append(privateNetworkFieldLabel, privateNetworkLabel, privateNetworkHint)

  const httpGroup = document.createElement('div')
  httpGroup.className = 'flex flex-col gap-4'
  httpGroup.append(
    makeField('Endpoint URL', urlInput, 'Remote Streamable HTTP (or legacy SSE) endpoint.'),
    privateNetworkField,
    makeGroup('Headers', headersBox, 'Optional request headers, e.g. Authorization. Secret values are masked after saving — leave a mask (••••abcd) untouched to keep the stored value, or type a new one to replace it.'),
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
    privateNetworkCheckbox.checked =
      !isStdio && prefill ? (prefill as { privateNetworkAllowed?: boolean }).privateNetworkAllowed === true : false

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
      ...(privateNetworkCheckbox.checked ? { privateNetworkAllowed: true } : {}),
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
