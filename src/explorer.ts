import './style.css'

type Field = { name: string; type: string; filled: number }
type CollectionInfo = { name: string; recordCount: number; fields: Field[] }
type StoredFile = {
  id: string
  name: string
  ext: string
  format: string
  size: number
  status: string
  source: string
  notes: string[]
  binary: boolean
  revision: number
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}
type FileSummary = StoredFile & { collectionCount: number; recordCount: number }
type FileDetail = { file: StoredFile; collections: CollectionInfo[] }
type RecordItem = {
  id: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
type RecordPage = {
  records: RecordItem[]
  total: number
  limit: number
  offset: number
  revision: number
  fields: Field[]
}
type DraftType = 'text' | 'number' | 'boolean' | 'json'
type DraftField = { key: string; type: DraftType; value: string }
type Filter = { field: string; op: string; value?: unknown }
type SavedView = {
  id: string
  collection: string
  name: string
  query: { q?: string; filters?: Filter[]; sort?: string; dir?: 'asc' | 'desc' }
}
type Version = {
  id: string
  revision: number
  size: number
  format: string
  reason: string
  createdAt: string
}

const pane = document.querySelector<HTMLElement>('#pane')!
const filesEl = document.querySelector<HTMLElement>('#files')!
const fileCount = document.querySelector<HTMLElement>('#file-count')!
const statsEl = document.querySelector<HTMLElement>('#stats')!
const drop = document.querySelector<HTMLLabelElement>('#drop')!
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const importInput = document.querySelector<HTMLInputElement>('#import-input')!
const drawer = document.querySelector<HTMLElement>('#drawer')!
const drawerTitle = document.querySelector<HTMLElement>('#drawer-title')!
const drawerBody = document.querySelector<HTMLElement>('#drawer-body')!
const drawerClose = document.querySelector<HTMLButtonElement>('#drawer-close')!
const addFieldButton = document.querySelector<HTMLButtonElement>('#add-field')!
const saveRecordButton = document.querySelector<HTMLButtonElement>('#save-record')!
const deleteRecordButton = document.querySelector<HTMLButtonElement>('#delete-record')!
const toastEl = document.querySelector<HTMLElement>('#toast')!
const keyInput = document.querySelector<HTMLInputElement>('#access-key')!
const trashToggle = document.querySelector<HTMLButtonElement>('#trash-toggle')!

const KEY_STORAGE = 'cabinet.access-key'
try {
  keyInput.value = localStorage.getItem(KEY_STORAGE) ?? ''
} catch {
  /* storage can be unavailable; the field still works for this page */
}

const state = {
  files: [] as FileSummary[],
  detail: null as FileDetail | null,
  collection: '',
  page: null as RecordPage | null,
  query: '',
  sort: '',
  dir: 'asc' as 'asc' | 'desc',
  offset: 0,
  limit: 50,
  filters: [] as Filter[],
  views: [] as SavedView[],
  revision: 1,
  editing: null as RecordItem | null,
  draft: [] as DraftField[],
  busy: false,
  versions: null as Version[] | null,
  trash: null as FileSummary[] | null,
  trashCount: 0,
}

const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  )

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const timeAgo = (iso: string) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  return `${Math.floor(seconds / 86_400)} d ago`
}

let toastTimer: number | undefined
function toast(message: string, tone: 'ok' | 'error' = 'ok') {
  toastEl.textContent = message
  toastEl.className = tone === 'error' ? 'toast error' : 'toast'
  toastEl.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true
  }, 4600)
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const raw = await response.text()
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function api<T>(path: string, init?: RequestInit, revision?: number): Promise<T> {
  const headers = new Headers(init?.headers)
  const key = keyInput.value.trim()
  if (key) headers.set('x-cabinet-key', key)
  if (revision) headers.set('If-Match', String(revision))

  let response = await fetch(path, { ...init, headers })
  let body = await parseBody(response)
  let error = (body as { error?: { code?: string; message?: string } } | null)?.error

  if (response.status === 409 && error?.code === 'source_changed') {
    if (window.confirm('The stored file changed outside Cabinet. Overwrite it with this change?')) {
      const forced = new Headers(headers)
      forced.set('x-cabinet-force', 'true')
      response = await fetch(path, { ...init, headers: forced })
      body = await parseBody(response)
      error = (body as { error?: { code?: string; message?: string } } | null)?.error
    }
  }

  if (response.status === 409 && error?.code === 'stale_revision') {
    toast('This file changed elsewhere; reloading it.', 'error')
    await refresh().catch(() => undefined)
    throw new ApiError('Reloaded the latest revision — try again.', 409, 'stale_revision')
  }

  if (!response.ok) {
    if (response.status === 401) keyInput.focus()
    const violations = (body as { violations?: { message?: string }[] } | null)?.violations
    const message = violations?.[0]?.message ?? error?.message ?? `Request failed (${response.status})`
    throw new ApiError(message, response.status, error?.code ?? '')
  }
  return body as T
}

/** A download link cannot carry the access key, so fetch the bytes with it. */
async function downloadFile(path: string) {
  const headers = new Headers()
  const key = keyInput.value.trim()
  if (key) headers.set('x-cabinet-key', key)
  try {
    const response = await fetch(path, { headers })
    if (!response.ok) throw new Error(`Download failed (${response.status}).`)
    const blob = await response.blob()
    const disposition = response.headers.get('content-disposition') ?? ''
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download'
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

function currentCollection(): CollectionInfo | undefined {
  return state.detail?.collections.find((entry) => entry.name === state.collection)
}

/* ------------------------------- rail ------------------------------- */

function renderRail() {
  fileCount.textContent = String(state.files.length)
  filesEl.innerHTML =
    state.files
      .map(
        (file) => `
        <button class="file-item" type="button" data-id="${esc(file.id)}"
          aria-current="${state.detail?.file.id === file.id}">
          <span class="file-ext">${esc(file.ext || 'file')}</span>
          <span class="file-text">
            <span class="file-name">${esc(file.name)}</span>
            <span class="file-meta">${plural(file.recordCount, 'record')} · ${plural(
              file.collectionCount,
              'collection',
            )}</span>
          </span>
        </button>`,
      )
      .join('') || '<p class="file-meta">Nothing stored yet.</p>'

  const collections = state.files.reduce((total, file) => total + file.collectionCount, 0)
  const records = state.files.reduce((total, file) => total + file.recordCount, 0)
  statsEl.textContent = state.files.length
    ? `${plural(state.files.length, 'file')} · ${collections} coll. · ${records} rec.`
    : 'No files yet'
  trashToggle.textContent = state.trashCount ? `Trash (${state.trashCount})` : 'Trash'
}

/* ------------------------------- pane ------------------------------- */

function renderPane() {
  if (state.trash) return renderTrash()
  if (state.versions && state.detail) return renderHistory()

  if (!state.detail) {
    pane.innerHTML = state.files.length
      ? `<div class="empty">
          <h2>Pick a file to open its collections.</h2>
          <p>Everything on the right comes from the API. The browser only draws what the server reads.</p>
        </div>`
      : `<div class="empty">
          <h2>Open a file. Read its collections. Edit every record.</h2>
          <p>Add any data file and the server works out what is inside it. Familiar shapes are
          read directly; anything else is handed to the model when a key is configured.</p>
          <ul class="empty-list">
            <li><b>JSON</b><span>Objects, arrays, nested collections and NDJSON lines</span></li>
            <li><b>XML</b><span>Repeated elements become records, attributes become fields</span></li>
            <li><b>CSV/TSV</b><span>Any of , ; tab or | with or without a header row</span></li>
            <li><b>JS</b><span>Exported object and array literals, read without evaluating code</span></li>
            <li><b>TXT/DAT</b><span>Key/value blocks, delimited tables, or the model</span></li>
          </ul>
        </div>`
    return
  }

  const { file, collections } = state.detail
  const attention = file.status !== 'ready'
  pane.innerHTML = `
    <header class="file-head">
      <div class="file-title">
        <span class="badge ${esc(file.format)}">${esc(file.format)}</span>
        <h2>${esc(file.name)}</h2>
        <p class="file-sub">
          ${plural(collections.length, 'collection')}
          · ${plural(collections.reduce((t, c) => t + c.recordCount, 0), 'record')}
          · ${formatBytes(file.size)}
          · revision ${file.revision}
          · read by ${file.source === 'ai' ? 'the model' : 'the server'}
          · updated ${timeAgo(file.updatedAt)}
        </p>
      </div>
      <div class="actions">
        <button type="button" data-action="read">Read again</button>
        <button type="button" data-action="read-ai">Read with AI</button>
        <button type="button" data-action="history">History</button>
        <button type="button" data-action="share">Share</button>
        <details class="menu">
          <summary>Export</summary>
          <div class="menu-panel">
            ${['json', 'ndjson', 'csv', 'xml', 'txt']
              .map(
                (format) =>
                  `<a href="/api/files/${esc(file.id)}/export?format=${format}" download>${format.toUpperCase()}</a>`,
              )
              .join('')}
            <a href="/api/files/${esc(file.id)}/source" download>stored file</a>
            <a href="/api/files/${esc(file.id)}/original" download>original upload</a>
          </div>
        </details>
        <button type="button" data-action="delete-file" class="danger-text">Move to trash</button>
        <button type="button" class="ghost" data-action="close-file" title="Close this file">Close</button>
      </div>
    </header>
    ${
      file.notes.length
        ? `<div class="notes" data-tone="${attention ? 'attention' : 'info'}">
            ${file.notes.map((note) => `<span>${esc(note)}</span>`).join('')}
          </div>`
        : ''
    }
    ${
      collections.length
        ? `<nav class="tabs" role="tablist">
            ${collections
              .map(
                (collection) => `
                <button class="tab" type="button" role="tab" data-collection="${esc(collection.name)}"
                  aria-selected="${collection.name === state.collection}">
                  ${esc(collection.name)}
                  <span class="tab-count">${collection.recordCount}</span>
                </button>`,
              )
              .join('')}
          </nav>
          <div class="table-bar">
            <input class="search" id="search" type="search" placeholder="Filter records"
              value="${esc(state.query)}" aria-label="Filter records" />
            <span class="count" id="count"></span>
            <details class="menu" style="margin-left:auto">
              <summary>Collection</summary>
              <div class="menu-panel">
                <button type="button" data-action="rename-field">Rename field…</button>
                <button type="button" data-action="delete-field">Delete field…</button>
                <button type="button" data-action="rename-collection">Rename collection…</button>
                <button type="button" data-action="import-merge">Import into this collection…</button>
                <button type="button" data-action="bulk-delete" class="danger-text">Delete matching records…</button>
                <button type="button" data-action="drop-collection" class="danger-text">Drop collection</button>
              </div>
            </details>
            <button class="primary" type="button" data-action="new-record">New record</button>
          </div>
          ${filtersMarkup()}
          <section class="table-wrap">
            <div class="table-scroll">
              <table>
                <thead><tr id="table-head"></tr></thead>
                <tbody id="table-body"></tbody>
              </table>
            </div>
            <div class="pager" id="pager"></div>
          </section>`
        : `<div class="notes" data-tone="attention">
            <span>No collections were read from this file. Try the model, or start a collection by hand.</span>
          </div>
          <div class="table-bar">
            <input class="search" id="new-collection" placeholder="New collection name" aria-label="New collection name" />
            <button class="primary" type="button" data-action="create-collection">Create collection</button>
          </div>`
    }`

  bindPane()
  if (collections.length) renderTable()
}

const FILTER_OPS: [string, string][] = [
  ['eq', '='],
  ['ne', '≠'],
  ['contains', 'contains'],
  ['gt', '>'],
  ['gte', '≥'],
  ['lt', '<'],
  ['lte', '≤'],
  ['exists', 'has value'],
  ['empty', 'is empty'],
]

function filtersMarkup(): string {
  const fields = currentCollection()?.fields ?? []
  if (!fields.length) return ''
  const filter = state.filters[0]
  const viewOptions = state.views.filter((view) => view.collection === state.collection)
  return `
    <div class="filters">
      <select id="filter-field" aria-label="Filter field">
        ${fields
          .map(
            (field) =>
              `<option value="${esc(field.name)}" ${filter?.field === field.name ? 'selected' : ''}>${esc(field.name)}</option>`,
          )
          .join('')}
      </select>
      <select id="filter-op" aria-label="Filter operator">
        ${FILTER_OPS.map(
          ([op, label]) =>
            `<option value="${op}" ${filter?.op === op ? 'selected' : ''}>${label}</option>`,
        ).join('')}
      </select>
      <input id="filter-value" placeholder="value" aria-label="Filter value"
        value="${esc(filter && filter.op !== 'exists' && filter.op !== 'empty' ? String(filter.value ?? '') : '')}" />
      <button type="button" data-action="apply-filter">Filter</button>
      ${state.filters.length ? '<button type="button" class="ghost" data-action="clear-filter">Clear</button>' : ''}
      <select id="view-select" aria-label="Saved views">
        <option value="">Saved views…</option>
        ${viewOptions.map((view) => `<option value="${esc(view.id)}">${esc(view.name)}</option>`).join('')}
      </select>
      <button type="button" class="ghost" data-action="save-view">Save view</button>
    </div>
    <div class="ask-bar">
      <input id="ask" placeholder="Ask about these rows, e.g. orders over 100 from Grace" aria-label="Ask the model" />
      <button type="button" data-action="ask">Ask</button>
    </div>`
}

function renderTable() {
  const head = pane.querySelector<HTMLElement>('#table-head')
  const body = pane.querySelector<HTMLElement>('#table-body')
  const pager = pane.querySelector<HTMLElement>('#pager')
  const count = pane.querySelector<HTMLElement>('#count')
  if (!head || !body || !pager) return

  const page = state.page
  const fields = page?.fields.length ? page.fields : (currentCollection()?.fields ?? [])
  const columns = fields.length ? fields.map((field) => field.name) : ['value']

  head.innerHTML = columns
    .map(
      (name) => `
      <th scope="col">
        <button type="button" data-sort="${esc(name)}">
          ${esc(name)}
          ${state.sort === name ? `<span class="sort-mark">${state.dir === 'asc' ? '↑' : '↓'}</span>` : ''}
        </button>
      </th>`,
    )
    .join('')
  head.querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const name = button.dataset.sort ?? ''
      if (state.sort === name) state.dir = state.dir === 'asc' ? 'desc' : 'asc'
      else {
        state.sort = name
        state.dir = 'asc'
      }
      state.offset = 0
      void loadRecords()
    })
  })

  if (!page) {
    body.innerHTML = `<tr><td class="table-empty" colspan="${columns.length}">Reading records…</td></tr>`
    return
  }

  if (!page.records.length) {
    body.innerHTML = `<tr><td class="table-empty" colspan="${columns.length}">
      ${state.query || state.filters.length ? 'No records match the filter.' : 'This collection is empty. Add the first record.'}
    </td></tr>`
  } else {
    body.innerHTML = page.records
      .map(
        (record) => `
        <tr data-record="${esc(record.id)}" tabindex="0">
          ${columns
            .map((column) => {
              const value = record.data[column]
              if (value === undefined) return '<td class="null">—</td>'
              if (value === null) return '<td class="null">null</td>'
              if (typeof value === 'object')
                return `<td class="mono">${esc(snippet(JSON.stringify(value)))}</td>`
              return `<td class="${typeof value === 'number' ? 'mono' : ''}">${esc(snippet(String(value)))}</td>`
            })
            .join('')}
        </tr>`,
      )
      .join('')
    body.querySelectorAll<HTMLTableRowElement>('tr[data-record]').forEach((row) => {
      const open = () => {
        const record = page.records.find((entry) => entry.id === row.dataset.record)
        if (record) openEditor(record)
      }
      row.addEventListener('click', open)
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') open()
      })
    })
  }

  if (count)
    count.textContent = `${page.total} found${state.query ? ` for “${state.query}”` : ''}`
  const from = page.total ? page.offset + 1 : 0
  const to = Math.min(page.offset + page.limit, page.total)
  pager.innerHTML = `
    <span>${from}–${to} of ${page.total}</span>
    <button type="button" data-page="prev" ${page.offset === 0 ? 'disabled' : ''}>Previous</button>
    <button type="button" data-page="next" ${to >= page.total ? 'disabled' : ''}>Next</button>`
  pager.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      state.offset =
        button.dataset.page === 'next'
          ? page.offset + page.limit
          : Math.max(0, page.offset - page.limit)
      void loadRecords()
    })
  })
}

const snippet = (value: string) => (value.length > 64 ? `${value.slice(0, 64)}…` : value)

/* ------------------------------ history ----------------------------- */

function renderHistory() {
  const file = state.detail!.file
  const versions = state.versions ?? []
  pane.innerHTML = `
    <header class="file-head">
      <div class="file-title">
        <span class="badge ${esc(file.format)}">${esc(file.format)}</span>
        <h2>History — ${esc(file.name)}</h2>
        <p class="file-sub">Current revision ${file.revision} · ${plural(versions.length, 'saved version')} kept</p>
      </div>
      <div class="actions">
        <button type="button" data-action="back">Back to records</button>
      </div>
    </header>
    <div class="history-list">
      ${
        versions
          .map(
            (version) => `
        <div class="version-row">
          <span class="version-what">
            <b>${esc(version.reason)}</b><br />
            <span class="version-meta">revision ${version.revision} · ${formatBytes(version.size)} · ${new Date(version.createdAt).toLocaleString()}</span>
          </span>
          <button type="button" data-version="${esc(version.id)}">Restore</button>
        </div>`,
          )
          .join('') || '<p class="trash-note">No versions yet. Every change saves one first.</p>'
      }
    </div>`
  pane.querySelectorAll<HTMLButtonElement>('[data-version]').forEach((button) =>
    button.addEventListener('click', () => void restoreVersion(button.dataset.version ?? '')),
  )
}

/* ------------------------------- trash ------------------------------ */

function renderTrash() {
  const files = state.trash ?? []
  pane.innerHTML = `
    <header class="file-head">
      <div class="file-title">
        <h2>Trash</h2>
        <p class="file-sub">${plural(files.length, 'file')} · records and history stay until a file is purged</p>
      </div>
      <div class="actions">
        <button type="button" data-action="back">Back to files</button>
        ${files.length ? '<button type="button" class="danger-text" data-action="empty-trash">Empty trash</button>' : ''}
      </div>
    </header>
    <div class="history-list">
      ${
        files
          .map(
            (file) => `
        <div class="version-row">
          <span class="version-what">
            <b>${esc(file.name)}</b><br />
            <span class="version-meta">${plural(file.recordCount, 'record')} · ${formatBytes(file.size)} · deleted ${timeAgo(file.deletedAt ?? file.updatedAt)}</span>
          </span>
          <button type="button" data-restore-file="${esc(file.id)}">Restore</button>
          <button type="button" class="danger-text" data-purge-file="${esc(file.id)}">Delete forever</button>
        </div>`,
          )
          .join('') || '<p class="trash-note">The trash is empty.</p>'
      }
    </div>`
  pane.querySelectorAll<HTMLButtonElement>('[data-restore-file]').forEach((button) =>
    button.addEventListener('click', () => void restoreFile(button.dataset.restoreFile ?? '')),
  )
  pane.querySelectorAll<HTMLButtonElement>('[data-purge-file]').forEach((button) =>
    button.addEventListener('click', () => void purgeFile(button.dataset.purgeFile ?? '')),
  )
}

/* ------------------------------- data ------------------------------- */

async function loadFiles(selectId?: string) {
  const { files } = await api<{ files: FileSummary[] }>('/api/files')
  state.files = files
  void loadStats()
  renderRail()
  const target = selectId ?? state.detail?.file.id ?? files[0]?.id
  if (target) await selectFile(target)
  else {
    state.detail = null
    renderPane()
  }
}

async function loadStats() {
  try {
    const stats = await api<{ trash: number }>('/api/stats')
    state.trashCount = stats.trash
    renderRail()
  } catch {
    /* the list already renders without the count */
  }
}

async function selectFile(id: string) {
  state.trash = null
  state.versions = null
  state.detail = await api<FileDetail>(`/api/files/${id}`)
  state.revision = state.detail.file.revision
  const collections = state.detail.collections
  if (!collections.some((entry) => entry.name === state.collection))
    state.collection = collections[0]?.name ?? ''
  state.page = null
  state.offset = 0
  state.sort = ''
  state.query = ''
  state.filters = []
  const views = await api<{ views: SavedView[] }>(`/api/files/${id}/views`).catch(() => ({ views: [] }))
  state.views = views.views
  renderRail()
  renderPane()
  if (state.collection) await loadRecords()
}

async function loadRecords() {
  if (!state.detail || !state.collection) return
  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(state.offset),
    dir: state.dir,
  })
  if (state.query) params.set('q', state.query)
  if (state.sort) params.set('sort', state.sort)
  if (state.filters.length) params.set('filter', JSON.stringify(state.filters))
  try {
    state.page = await api<RecordPage>(
      `/api/files/${state.detail.file.id}/records/${encodeURIComponent(state.collection)}?${params}`,
    )
    state.revision = state.page.revision
    renderTable()
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function refresh() {
  if (!state.detail) return
  const id = state.detail.file.id
  state.detail = await api<FileDetail>(`/api/files/${id}`)
  state.revision = state.detail.file.revision
  state.versions = null
  renderRail()
  renderPane()
  if (state.collection) await loadRecords()
}

/* ------------------------------ upload ------------------------------ */

async function upload(file: File) {
  if (!file || state.busy) return
  state.busy = true
  drop.classList.add('busy')
  toast(`Reading ${file.name}…`)
  try {
    const detail = await api<FileDetail>(`/api/files?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
    })
    state.trash = null
    state.collection = detail.collections[0]?.name ?? ''
    await loadFiles(detail.file.id)
    toast(
      detail.collections.length
        ? `${file.name} is open with ${plural(detail.collections.length, 'collection')}.`
        : `${file.name} is stored, but its structure needs the model.`,
      detail.collections.length ? 'ok' : 'error',
    )
  } catch (error) {
    toast((error as Error).message, 'error')
  } finally {
    state.busy = false
    drop.classList.remove('busy')
    fileInput.value = ''
  }
}

/* ------------------------------ editor ------------------------------ */

function draftFrom(key: string, value: unknown): DraftField {
  if (value === null || value === undefined) return { key, type: 'text', value: '' }
  if (typeof value === 'boolean') return { key, type: 'boolean', value: String(value) }
  if (typeof value === 'number') return { key, type: 'number', value: String(value) }
  if (typeof value === 'object') return { key, type: 'json', value: JSON.stringify(value, null, 2) }
  return { key, type: 'text', value: String(value) }
}

function openEditor(record: RecordItem | null) {
  state.editing = record
  const collection = currentCollection()
  const keys = record ? Object.keys(record.data) : (collection?.fields.map((field) => field.name) ?? [])
  state.draft = keys.length
    ? keys.map((key) => draftFrom(key, record?.data[key]))
    : [{ key: '', type: 'text', value: '' }]
  drawerTitle.textContent = record
    ? `Edit record in ${state.collection}`
    : `New record in ${state.collection}`
  deleteRecordButton.hidden = !record
  renderDraft()
  drawer.hidden = false
  document.body.style.overflow = 'hidden'
  drawerBody.querySelector<HTMLInputElement>('.field-name')?.focus()
}

function closeEditor() {
  drawer.hidden = true
  document.body.style.overflow = ''
  state.editing = null
  state.draft = []
}

function renderDraft() {
  drawerBody.innerHTML = state.draft
    .map((field, index) => {
      const control =
        field.type === 'boolean'
          ? `<select class="field-value">
              <option value="true" ${field.value === 'true' ? 'selected' : ''}>true</option>
              <option value="false" ${field.value === 'false' ? 'selected' : ''}>false</option>
            </select>`
          : field.type === 'json'
            ? `<textarea class="field-value" spellcheck="false">${esc(field.value)}</textarea>`
            : `<input class="field-value" type="${field.type === 'number' ? 'number' : 'text'}"
                value="${esc(field.value)}" />`
      return `
        <div class="field-row" data-index="${index}">
          <div class="field-top">
            <input class="field-name" value="${esc(field.key)}" placeholder="field name" spellcheck="false" />
            <select class="field-type" aria-label="Field type">
              ${(['text', 'number', 'boolean', 'json'] as DraftType[])
                .map(
                  (type) =>
                    `<option value="${type}" ${field.type === type ? 'selected' : ''}>${type}</option>`,
                )
                .join('')}
            </select>
            <button class="remove-field" type="button" aria-label="Remove field">×</button>
          </div>
          ${control}
        </div>`
    })
    .join('')

  drawerBody
    .querySelectorAll<HTMLInputElement>('.field-name')
    .forEach((input) =>
      input.addEventListener('input', () => {
        const index = Number(input.closest<HTMLElement>('.field-row')!.dataset.index)
        state.draft[index]!.key = input.value
      }),
    )
  drawerBody.querySelectorAll<HTMLSelectElement>('.field-type').forEach((select) =>
    select.addEventListener('change', () => {
      const row = select.closest<HTMLElement>('.field-row')!
      const index = Number(row.dataset.index)
      const field = state.draft[index]!
      field.type = select.value as DraftType
      if (field.type === 'boolean' && field.value !== 'true' && field.value !== 'false')
        field.value = 'true'
      renderDraft()
    }),
  )
  drawerBody
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('.field-value')
    .forEach((input) =>
      input.addEventListener('input', () => {
        const index = Number(input.closest<HTMLElement>('.field-row')!.dataset.index)
        state.draft[index]!.value = input.value
      }),
    )
  drawerBody.querySelectorAll<HTMLButtonElement>('.remove-field').forEach((button) =>
    button.addEventListener('click', () => {
      const index = Number(button.closest<HTMLElement>('.field-row')!.dataset.index)
      state.draft.splice(index, 1)
      if (!state.draft.length) state.draft.push({ key: '', type: 'text', value: '' })
      renderDraft()
    }),
  )
}

function buildRow(): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const field of state.draft) {
    const key = field.key.trim()
    if (!key) continue
    if (key in row) throw new Error(`“${key}” appears twice.`)
    if (field.type === 'number') {
      if (field.value.trim() === '') row[key] = null
      else {
        const number = Number(field.value)
        if (!Number.isFinite(number)) throw new Error(`“${key}” is not a number.`)
        row[key] = number
      }
    } else if (field.type === 'boolean') row[key] = field.value === 'true'
    else if (field.type === 'json') {
      if (field.value.trim() === '') row[key] = null
      else {
        try {
          row[key] = JSON.parse(field.value)
        } catch {
          throw new Error(`“${key}” is not valid JSON.`)
        }
      }
    } else row[key] = field.value
  }
  if (!Object.keys(row).length) throw new Error('Add at least one named field.')
  return row
}

async function saveRecord() {
  if (!state.detail || !state.collection) return
  let row: Record<string, unknown>
  try {
    row = buildRow()
  } catch (error) {
    toast((error as Error).message, 'error')
    return
  }
  saveRecordButton.disabled = true
  const editing = Boolean(state.editing)
  try {
    const base = `/api/files/${state.detail.file.id}/records/${encodeURIComponent(state.collection)}`
    if (state.editing)
      await api(
        `${base}/${state.editing.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(row),
        },
        state.revision,
      )
    else
      await api(
        base,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(row),
        },
        state.revision,
      )
    closeEditor()
    await refresh()
    toast(editing ? 'Record saved.' : 'Record added.')
  } catch (error) {
    toast((error as Error).message, 'error')
  } finally {
    saveRecordButton.disabled = false
  }
}

async function removeRecord() {
  if (!state.detail || !state.collection || !state.editing) return
  if (!window.confirm('Delete this record? The change is saved in the file history.')) return
  try {
    await api(
      `/api/files/${state.detail.file.id}/records/${encodeURIComponent(state.collection)}/${state.editing.id}`,
      { method: 'DELETE' },
      state.revision,
    )
    closeEditor()
    await refresh()
    toast('Record deleted.')
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

/* ------------------------------ actions ----------------------------- */

async function readFile(mode: 'heuristic' | 'ai') {
  if (!state.detail) return
  toast(mode === 'ai' ? 'Asking the model to read the file…' : 'Reading the file again…')
  try {
    state.detail = await api<FileDetail>(
      `/api/files/${state.detail.file.id}/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      },
      state.revision,
    )
    state.revision = state.detail.file.revision
    if (!state.detail.collections.some((entry) => entry.name === state.collection))
      state.collection = state.detail.collections[0]?.name ?? ''
    renderRail()
    renderPane()
    if (state.collection) await loadRecords()
    toast(
      state.detail.collections.length
        ? `Read ${plural(state.detail.collections.length, 'collection')}.`
        : 'No collections were found.',
      state.detail.collections.length ? 'ok' : 'error',
    )
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

function closeFile() {
  if (!state.detail) return
  closeEditor()
  state.detail = null
  state.collection = ''
  state.page = null
  state.query = ''
  state.sort = ''
  state.dir = 'asc'
  state.offset = 0
  state.filters = []
  state.views = []
  state.versions = null
  state.trash = null
  renderRail()
  renderPane()
}

async function deleteFile() {
  if (!state.detail) return
  const name = state.detail.file.name
  if (!window.confirm(`Move ${name} to the trash? You can restore it later.`)) return
  try {
    await api(`/api/files/${state.detail.file.id}`, { method: 'DELETE' })
    state.detail = null
    state.collection = ''
    state.page = null
    await loadFiles()
    await loadStats()
    toast(`${name} is in the trash.`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function showHistory() {
  if (!state.detail) return
  try {
    const { versions } = await api<{ versions: Version[] }>(
      `/api/files/${state.detail.file.id}/versions`,
    )
    state.versions = versions
    state.trash = null
    renderPane()
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function restoreVersion(versionId: string) {
  if (!state.detail) return
  if (!window.confirm('Replace the current file with this version? The current one is kept in history.'))
    return
  try {
    state.detail = await api<FileDetail>(
      `/api/files/${state.detail.file.id}/versions/${versionId}/restore`,
      { method: 'POST' },
      state.revision,
    )
    state.revision = state.detail.file.revision
    state.versions = null
    if (!state.detail.collections.some((entry) => entry.name === state.collection))
      state.collection = state.detail.collections[0]?.name ?? ''
    renderRail()
    renderPane()
    if (state.collection) await loadRecords()
    toast('Version restored.')
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function shareFile() {
  if (!state.detail) return
  const answer = window.prompt('Create a read-only link for how many hours?', '24')
  const hours = Number(answer)
  if (!answer || !Number.isFinite(hours) || hours < 1) return
  try {
    const result = await api<{ url: string }>(`/api/files/${state.detail.file.id}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlHours: Math.round(hours) }),
    })
    try {
      await navigator.clipboard.writeText(result.url)
      toast(`Read-only link copied: ${result.url}`)
    } catch {
      toast(`Read-only link: ${result.url}`)
    }
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function showTrash() {
  try {
    const { files } = await api<{ files: FileSummary[] }>('/api/trash')
    state.trash = files
    state.versions = null
    renderPane()
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function restoreFile(id: string) {
  try {
    const detail = await api<FileDetail>(`/api/files/${id}/restore`, { method: 'POST' })
    state.trash = null
    await loadFiles(detail.file.id)
    await loadStats()
    toast(`${detail.file.name} was restored.`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function purgeFile(id: string) {
  const file = state.trash?.find((entry) => entry.id === id)
  if (!window.confirm(`Delete ${file?.name ?? 'this file'} and all its history for good?`)) return
  try {
    await api(`/api/files/${id}/purge`, { method: 'DELETE' })
    await showTrash()
    await loadStats()
    toast('File deleted for good.')
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function emptyTrash() {
  if (!window.confirm('Delete every trashed file and its history for good?')) return
  try {
    const result = await api<{ purged: number }>('/api/trash', { method: 'DELETE' })
    await showTrash()
    await loadStats()
    toast(`Purged ${plural(result.purged, 'file')}.`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

function bulkUrl(): string {
  if (!state.detail) throw new Error('Open a file first.')
  return `/api/files/${state.detail.file.id}/collections/${encodeURIComponent(state.collection)}/bulk`
}

async function deleteMatching() {
  if (!state.detail || !state.collection) return
  const filter = {
    q: state.query || undefined,
    filters: state.filters.length ? state.filters : undefined,
  }
  try {
    const preview = await api<{ matched: number }>(
      bulkUrl(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ...filter, dryRun: true }),
      },
      state.revision,
    )
    if (!preview.matched) return toast('Nothing matches this filter.', 'error')
    if (!window.confirm(`Delete ${plural(preview.matched, 'matching record')}?`)) return
    const result = await api<{ applied: number }>(
      bulkUrl(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ...filter, dryRun: false }),
      },
      state.revision,
    )
    await refresh()
    toast(`Deleted ${plural(result.applied, 'record')}.`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function schemaAction(body: Record<string, unknown>, label: string) {
  if (!state.detail || !state.collection) return
  try {
    const result = await api<FileDetail & { changed: number; failed: number }>(
      `/api/files/${state.detail.file.id}/collections/${encodeURIComponent(state.collection)}/schema`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      state.revision,
    )
    state.detail = result
    state.revision = result.file.revision
    if (!state.detail.collections.some((entry) => entry.name === state.collection))
      state.collection = state.detail.collections[0]?.name ?? ''
    renderRail()
    renderPane()
    if (state.collection) await loadRecords()
    toast(`${label}: ${plural(result.changed, 'record')} changed${result.failed ? `, ${result.failed} skipped` : ''}.`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function renameField() {
  const fields = currentCollection()?.fields ?? []
  const from = window.prompt('Field to rename', fields[0]?.name ?? '')
  if (!from) return
  const to = window.prompt(`Rename “${from}” to`, from)
  if (!to || to === from) return
  await schemaAction({ action: 'rename_field', from, to }, 'Renamed field')
}

async function deleteField() {
  const fields = currentCollection()?.fields ?? []
  const field = window.prompt('Field to delete from every record', fields[0]?.name ?? '')
  if (!field) return
  if (!window.confirm(`Remove “${field}” from every record in ${state.collection}?`)) return
  await schemaAction({ action: 'delete_field', field }, 'Deleted field')
}

async function renameCollection() {
  if (!state.collection) return
  const name = window
    .prompt('New collection name (lowercase, underscores)', state.collection)
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
  if (!name || name === state.collection) return
  const previous = state.collection
  await schemaAction({ action: 'rename', name }, 'Renamed collection')
  if (state.detail?.collections.some((entry) => entry.name === name)) state.collection = name
  else state.collection = previous
}

async function dropCollection() {
  if (!state.detail || !state.collection) return
  if (!window.confirm(`Drop the ${state.collection} collection and all its records?`)) return
  try {
    state.detail = await api<FileDetail>(
      `/api/files/${state.detail.file.id}/collections/${encodeURIComponent(state.collection)}`,
      { method: 'DELETE' },
      state.revision,
    )
    state.revision = state.detail.file.revision
    state.collection = state.detail.collections[0]?.name ?? ''
    renderRail()
    renderPane()
    if (state.collection) await loadRecords()
    toast('Collection dropped.')
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function importInto(file: File) {
  if (!state.detail || !state.collection) return
  const key = window.prompt('Match rows on a field (leave blank to append)?', '')?.trim() ?? ''
  const params = new URLSearchParams({ name: file.name, mode: key ? 'upsert' : 'append' })
  if (key) params.set('key', key)
  try {
    toast(`Importing ${file.name}…`)
    const result = await api<{
      inserted: number
      updated: number
      skipped: number
      truncated: boolean
    }>(
      `/api/files/${state.detail.file.id}/collections/${encodeURIComponent(state.collection)}/import?${params}`,
      { method: 'POST', body: file },
      state.revision,
    )
    await refresh()
    toast(
      `Imported: ${result.inserted} added, ${result.updated} updated, ${result.skipped} skipped.${result.truncated ? ' Only the first 5,000 rows were read.' : ''}`,
    )
  } catch (error) {
    toast((error as Error).message, 'error')
  } finally {
    importInput.value = ''
  }
}

async function askModel() {
  if (!state.detail || !state.collection) return
  const input = pane.querySelector<HTMLInputElement>('#ask')
  const question = input?.value.trim() ?? ''
  if (question.length < 2) return toast('Ask a question about these rows.', 'error')
  try {
    const result = await api<{
      explanation: string
      plan: { filters: Filter[]; sort?: string }
      total: number
    }>(
      `/api/files/${state.detail.file.id}/ask`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: state.collection, question, mode: 'query' }),
      },
      state.revision,
    )
    state.filters = result.plan.filters ?? []
    if (result.plan.sort) state.sort = result.plan.sort
    state.offset = 0
    renderPane()
    await loadRecords()
    toast(`${result.explanation} — ${plural(result.total, 'row')}`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function saveView() {
  if (!state.detail || !state.collection) return
  const name = window.prompt('Name this view')
  if (!name) return
  try {
    await api(`/api/files/${state.detail.file.id}/views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: state.collection,
        name,
        query: {
          q: state.query || undefined,
          filters: state.filters,
          sort: state.sort || undefined,
          dir: state.dir,
        },
      }),
    })
    const views = await api<{ views: SavedView[] }>(`/api/files/${state.detail.file.id}/views`)
    state.views = views.views
    renderPane()
    await loadRecords()
    toast(`Saved view “${name}”.`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

function applyView(viewId: string) {
  const view = state.views.find((entry) => entry.id === viewId)
  if (!view) return
  state.query = view.query.q ?? ''
  state.filters = view.query.filters ?? []
  state.sort = view.query.sort ?? ''
  state.dir = view.query.dir ?? 'asc'
  state.offset = 0
  renderPane()
  void loadRecords()
}

async function createCollection() {
  if (!state.detail) return
  const input = pane.querySelector<HTMLInputElement>('#new-collection')
  const name = (input?.value ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (!name) {
    toast('Give the collection a name using letters, numbers and underscores.', 'error')
    return
  }
  try {
    const detail = await api<FileDetail>(
      `/api/files/${state.detail.file.id}/collections`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
      state.revision,
    )
    state.detail = detail
    state.revision = detail.file.revision
    state.collection = name
    renderRail()
    renderPane()
    await loadRecords()
    toast(`Created ${name}.`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

/* ------------------------------ wiring ------------------------------ */

function bindPane() {
  const search = pane.querySelector<HTMLInputElement>('#search')
  if (search) {
    let timer: number | undefined
    search.addEventListener('input', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        state.query = search.value.trim()
        state.offset = 0
        void loadRecords()
      }, 240)
    })
  }

  pane.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.collection ?? ''
      if (name === state.collection) return
      state.collection = name
      state.offset = 0
      state.sort = ''
      state.query = ''
      state.filters = []
      renderPane()
      void loadRecords()
    })
  })

  const viewSelect = pane.querySelector<HTMLSelectElement>('#view-select')
  viewSelect?.addEventListener('change', () => applyView(viewSelect.value))
}

function applyFilter() {
  const field = pane.querySelector<HTMLSelectElement>('#filter-field')?.value ?? ''
  const op = pane.querySelector<HTMLSelectElement>('#filter-op')?.value ?? 'eq'
  const raw = pane.querySelector<HTMLInputElement>('#filter-value')?.value ?? ''
  const info = currentCollection()?.fields.find((entry) => entry.name === field)
  let value: unknown = raw
  if (op !== 'exists' && op !== 'empty') {
    if (info?.type === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw)))
      value = Number(raw)
    else if (raw === 'true' || raw === 'false') value = raw === 'true'
  }
  state.filters = op === 'exists' || op === 'empty' ? [{ field, op }] : [{ field, op, value }]
  state.offset = 0
  renderPane()
  void loadRecords()
}

filesEl.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.file-item')
  if (button?.dataset.id && button.dataset.id !== state.detail?.file.id)
    void selectFile(button.dataset.id)
})

trashToggle.addEventListener('click', () => void showTrash())

pane.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[download]')
  if (link) {
    event.preventDefault()
    void downloadFile(link.getAttribute('href') ?? '')
    return
  }
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
  const action = target?.dataset.action
  if (action === 'read') void readFile('heuristic')
  if (action === 'read-ai') void readFile('ai')
  if (action === 'delete-file') void deleteFile()
  if (action === 'close-file') closeFile()
  if (action === 'new-record') openEditor(null)
  if (action === 'create-collection') void createCollection()
  if (action === 'history') void showHistory()
  if (action === 'share') void shareFile()
  if (action === 'back') {
    state.trash = null
    state.versions = null
    renderPane()
  }
  if (action === 'empty-trash') void emptyTrash()
  if (action === 'apply-filter') applyFilter()
  if (action === 'clear-filter') {
    state.filters = []
    state.offset = 0
    renderPane()
    void loadRecords()
  }
  if (action === 'save-view') void saveView()
  if (action === 'ask') void askModel()
  if (action === 'rename-field') void renameField()
  if (action === 'delete-field') void deleteField()
  if (action === 'rename-collection') void renameCollection()
  if (action === 'drop-collection') void dropCollection()
  if (action === 'bulk-delete') void deleteMatching()
  if (action === 'import-merge') importInput.click()
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) void upload(file)
})

importInput.addEventListener('change', () => {
  const file = importInput.files?.[0]
  if (file) void importInto(file)
})

drop.addEventListener('dragover', (event) => {
  event.preventDefault()
  drop.classList.add('over')
})
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (event) => {
  event.preventDefault()
  drop.classList.remove('over')
  const file = event.dataTransfer?.files?.[0]
  if (file) void upload(file)
})

drawerClose.addEventListener('click', closeEditor)
drawer.addEventListener('click', (event) => {
  if (event.target === drawer) closeEditor()
})
addFieldButton.addEventListener('click', () => {
  state.draft.push({ key: '', type: 'text', value: '' })
  renderDraft()
  const inputs = drawerBody.querySelectorAll<HTMLInputElement>('.field-name')
  inputs[inputs.length - 1]?.focus()
})
saveRecordButton.addEventListener('click', () => void saveRecord())
deleteRecordButton.addEventListener('click', () => void removeRecord())

function rememberKey() {
  const key = keyInput.value.trim()
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key)
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    /* nothing to persist */
  }
}

keyInput.addEventListener('change', () => {
  rememberKey()
  void loadFiles(state.detail?.file.id)
})

/** Another tab (or a script) may change this file; poll and follow it quietly. */
async function pollRevision() {
  if (document.hidden || !state.detail || !drawer.hidden || state.busy) return
  if (state.trash || state.versions) return
  const id = state.detail.file.id
  const detail = await api<FileDetail>(`/api/files/${id}`).catch(() => null)
  if (!detail || !state.detail || state.detail.file.id !== id) return
  if (detail.file.revision === state.detail.file.revision) return
  state.detail = detail
  state.revision = detail.file.revision
  if (!detail.collections.some((entry) => entry.name === state.collection))
    state.collection = detail.collections[0]?.name ?? ''
  renderRail()
  renderPane()
  await loadRecords()
  toast('This file changed elsewhere; the view is up to date.')
}

window.setInterval(() => void pollRevision(), 12_000)

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !drawer.hidden) closeEditor()
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !drawer.hidden)
    void saveRecord()
})

async function boot() {
  try {
    await loadFiles()
  } catch (error) {
    pane.innerHTML = `<div class="empty">
      <h2>The API did not answer.</h2>
      <p>${esc((error as Error).message)}</p>
    </div>`
  }
}

void boot()
