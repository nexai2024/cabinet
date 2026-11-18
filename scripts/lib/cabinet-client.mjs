export class CabinetError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'CabinetError'
    this.status = status
    this.code = code
  }
}

export class CabinetClient {
  constructor(options = {}) {
    this.url = (options.url ?? process.env.CABINET_URL ?? 'http://localhost:5173').replace(/\/$/, '')
    this.token = options.token ?? process.env.CABINET_TOKEN ?? ''
  }

  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const finalHeaders = { ...headers }
    if (this.token) finalHeaders['x-cabinet-key'] = this.token

    let payload = body
    if (
      payload !== undefined &&
      typeof payload !== 'string' &&
      !(payload instanceof Uint8Array) &&
      !(payload instanceof ArrayBuffer)
    ) {
      finalHeaders['Content-Type'] = 'application/json'
      payload = JSON.stringify(payload)
    }

    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: finalHeaders,
      body: payload,
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
    if (!response.ok)
      throw new CabinetError(
        parsed?.error?.message ?? `Request failed (${response.status})`,
        response.status,
        parsed?.error?.code ?? '',
      )
    return parsed
  }

  listFiles(trash = false) {
    return this.request(`/api/files${trash ? '?trash=true' : ''}`)
  }

  stats() {
    return this.request('/api/stats')
  }

  detail(id) {
    return this.request(`/api/files/${encodeURIComponent(id)}`)
  }

  async resolveFile(nameOrId) {
    const { files } = await this.listFiles()
    const wanted = String(nameOrId).toLowerCase()
    const match =
      files.find((file) => file.id === nameOrId) ??
      files.find((file) => file.name.toLowerCase() === wanted)
    if (!match) throw new CabinetError(`No stored file matches “${nameOrId}”.`, 404, 'file_not_found')
    return match
  }

  records(id, collection, params = {}) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== '') query.set(key, String(value))
    const suffix = query.toString() ? `?${query}` : ''
    return this.request(
      `/api/files/${encodeURIComponent(id)}/records/${encodeURIComponent(collection)}${suffix}`,
    )
  }

  createRecord(id, collection, row) {
    return this.request(
      `/api/files/${encodeURIComponent(id)}/records/${encodeURIComponent(collection)}`,
      { method: 'POST', body: row },
    )
  }

  updateRecord(id, collection, recordId, row) {
    return this.request(
      `/api/files/${encodeURIComponent(id)}/records/${encodeURIComponent(collection)}/${encodeURIComponent(recordId)}`,
      { method: 'PATCH', body: row },
    )
  }

  deleteRecord(id, collection, recordId) {
    return this.request(
      `/api/files/${encodeURIComponent(id)}/records/${encodeURIComponent(collection)}/${encodeURIComponent(recordId)}`,
      { method: 'DELETE' },
    )
  }

  readFile(id, mode = 'heuristic') {
    return this.request(`/api/files/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      body: { mode },
    })
  }

  versions(id) {
    return this.request(`/api/files/${encodeURIComponent(id)}/versions`)
  }

  restoreVersion(id, versionId) {
    return this.request(
      `/api/files/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: 'POST' },
    )
  }

  importFile(id, collection, bytes, name, key) {
    const query = new URLSearchParams({ name, mode: key ? 'upsert' : 'append' })
    if (key) query.set('key', key)
    return this.request(
      `/api/files/${encodeURIComponent(id)}/collections/${encodeURIComponent(collection)}/import?${query}`,
      {
        method: 'POST',
        body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    )
  }

  ask(id, collection, question, mode = 'query', target) {
    return this.request(`/api/files/${encodeURIComponent(id)}/ask`, {
      method: 'POST',
      body: { collection, question, mode, target },
    })
  }

  events(id) {
    return this.request(`/api/files/${encodeURIComponent(id)}/events`)
  }

  trash() {
    return this.request('/api/trash')
  }

  trashFile(id) {
    return this.request(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  restoreFile(id) {
    return this.request(`/api/files/${encodeURIComponent(id)}/restore`, { method: 'POST' })
  }
}
