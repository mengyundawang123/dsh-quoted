/**
 * Host half of the Annotation Capture bundle.
 *
 * The browser cannot write workspace files, so this half exposes one same-origin
 * route that turns a captured selection into a Markdown file inside the Session's
 * workspace. The Client half owns the selection UI and the composer insertion.
 *
 * Lifetime: a file belongs to the message that references it, and is deleted only when
 * the turn that opened it closes:
 *   - `turnOwned` snapshots the files that existed when a turn started, so a file the
 *     user writes while the model is working belongs to the next message — comparing
 *     timestamps cannot express that, because both can land in the same millisecond;
 *   - a file is deleted only after a finished `read` call named it, so an annotation
 *     the model never opened survives instead of vanishing unread;
 *   - aborted turns never reach `agent/turn-stopping`, so a retry still finds its file;
 *   - anything nothing tracks is swept by age, at turn close and once after boot.
 */
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

const ROUTE = '/api/dsh-quoted'
const MAX_BODY_BYTES = 256 * 1024
const DIRECTORY = '.dsh-annotations'
const HEADER = 'x-dsh-quoted'
const ORPHAN_AGE_MS = 60 * 60 * 1000
const WINDOWS = process.platform === 'win32'

/** sessionId → file path → { read }. */
const pending = new Map()

/** sessionId → the paths that belonged to the turn when it started. */
const turnOwned = new Map()

/** sessionId → the directory last observed for it, so an idle Session still resolves. */
const sessionDirs = new Map()

export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (req, res) => handler(ctx, req, res),
  }))

  // A turn owns exactly the files that already existed when its first message was
  // claimed. Later claims inside the same turn keep the original snapshot.
  ctx.effect(() => ctx.on('agent/inbox/claimed', (payload) => {
    beginTurn(ctx, payload === null || payload === undefined ? undefined : payload.agent)
  }))

  // Safety net: a turn that starts without a claim still gets a snapshot, and a turn
  // that ends without `turn-stopping` (aborted) releases it here.
  ctx.effect(() => ctx.on('agent/status', (payload) => {
    const sessionId = sessionOf(payload === null || payload === undefined ? undefined : payload.agent)
    if (sessionId === undefined) return
    if (payload.status === 'running') {
      beginTurn(ctx, payload.agent)
      return
    }
    turnOwned.delete(sessionId)
  }))

  // Proof that the model actually opened a file: a finished `read` call naming it.
  ctx.effect(() => ctx.on('tools/result', (exec) => {
    markRead(exec)
  }))

  // The annotation is input for exactly one turn: once the model owes no further
  // response, the files it opened can go.
  ctx.effect(() => ctx.on('agent/turn-stopping', async (payload) => {
    const agent = payload === null || payload === undefined ? undefined : payload.agent
    const sessionId = sessionOf(agent)
    if (sessionId === undefined) return
    const owned = turnOwned.get(sessionId)
    turnOwned.delete(sessionId)
    await discard(sessionId, owned)
    try {
      const directory = directoryOf(ctx, agent)
      if (typeof directory === 'string' && isAbsolute(directory)) {
        await sweep(join(directory, DIRECTORY))
      }
    } catch {
      // The working-directory service is optional for this cleanup.
    }
  }))

  // Registrations die with the process, so a restart forgets which files were pending.
  // One sweep over the registered workspaces collects them without waiting for a turn.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void sweepWorkspaces(ctx)
    }, 5000)
    return () => clearTimeout(timer)
  })
}

function sessionOf(agent) {
  if (agent === null || agent === undefined) return undefined
  const session = agent.session
  if (session !== null && session !== undefined && typeof session.id === 'string') return session.id
  return typeof agent.id === 'string' ? agent.id : undefined
}

/** An optional service read through `ctx.get`, which does not require declaring it. */
function service(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** The Agent currently driving a Session, if that Session is still live in the Host. */
function agentOf(ctx, sessionId) {
  const agents = service(ctx, 'agents')
  if (agents === undefined || agents === null) return undefined
  try {
    return agents.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * A Session's effective directory. The working-directory service owns runtime changes;
 * the Session header carries the directory it was created with.
 */
function directoryOf(ctx, agent) {
  if (agent === null || agent === undefined) return undefined
  const workingDirectory = service(ctx, 'workingDirectory')
  if (workingDirectory !== undefined && workingDirectory !== null) {
    try {
      const path = workingDirectory.get(agent.session)
      if (typeof path === 'string' && path !== '') return path
    } catch {
      // Fall through to the header value.
    }
  }
  const header = agent.session === null || agent.session === undefined ? undefined : agent.session.header
  const cwd = header === null || header === undefined ? undefined : header.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function beginTurn(ctx, agent) {
  const sessionId = sessionOf(agent)
  if (sessionId === undefined) return
  const directory = directoryOf(ctx, agent)
  if (directory !== undefined) sessionDirs.set(sessionId, directory)
  if (turnOwned.has(sessionId)) return
  const files = pending.get(sessionId)
  turnOwned.set(sessionId, new Set(files === undefined ? [] : files.keys()))
}

function normalize(path) {
  const absolute = resolve(path)
  return WINDOWS ? absolute.toLowerCase() : absolute
}

function samePath(left, right) {
  try {
    return normalize(left) === normalize(right)
  } catch {
    return false
  }
}

function isInside(parent, child) {
  try {
    const base = normalize(parent)
    const target = normalize(child)
    return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
  } catch {
    return false
  }
}

function parseArguments(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** Mark every pending file a finished `read` call opened. */
function markRead(exec) {
  if (exec === null || exec === undefined) return
  if (exec.name !== 'read') return
  const sessionId = sessionOf(exec.agent)
  if (sessionId === undefined) return
  const files = pending.get(sessionId)
  if (files === undefined) return
  const args = parseArguments(exec.arguments)
  if (args === null || typeof args !== 'object' || typeof args.file_path !== 'string') return
  for (const [file, entry] of files) {
    if (samePath(file, args.file_path)) entry.read = true
  }
}

/** Every path still tracked by a Session, so a filesystem sweep never takes a live file. */
function livePaths() {
  const live = new Set()
  for (const files of pending.values()) {
    for (const file of files.keys()) live.add(normalize(file))
  }
  return live
}

/**
 * Delete the files this turn owned and the model actually opened. Anything written
 * after the turn started stays: it belongs to the message the user is composing.
 */
async function discard(sessionId, owned) {
  const files = pending.get(sessionId)
  if (files === undefined) return
  const scope = owned === undefined ? new Set(files.keys()) : owned
  for (const [file, entry] of [...files]) {
    if (!scope.has(file)) continue
    // Never opened by the model: deleting it would lose the annotation outright.
    if (entry.read !== true) continue
    files.delete(file)
    await unlink(file).catch(() => undefined)
  }
  if (files.size === 0) pending.delete(sessionId)
}

/**
 * Delete annotations nothing tracks any more. A file any Session still tracks is never
 * swept: it may be a draft the user has not sent yet.
 */
async function sweep(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  const live = livePaths()
  const now = Date.now()
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map(async (entry) => {
      const file = join(directory, entry.name)
      try {
        if (live.has(normalize(file))) return
        const info = await stat(file)
        if (now - info.mtimeMs > ORPHAN_AGE_MS) await unlink(file)
      } catch {
        // A file that vanished or is locked is left alone.
      }
    }))
}

async function sweepWorkspaces(ctx) {
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || registry === null) return
  let workspaces
  try {
    workspaces = registry.list() ?? []
  } catch {
    return
  }
  await Promise.all(workspaces.map((workspace) => {
    if (workspace === null || workspace === undefined || typeof workspace.path !== 'string') return undefined
    return sweep(join(workspace.path, DIRECTORY))
  }))
}

function remember(payload, path) {
  const sessionId = payload !== null && typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (sessionId === '') return
  const files = pending.get(sessionId) ?? new Map()
  files.set(path, { read: false })
  pending.set(sessionId, files)
}

function registeredPaths(ctx) {
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || registry === null) return []
  try {
    const workspaces = registry.list() ?? []
    return workspaces.map((workspace) => workspace?.path).filter((path) => typeof path === 'string')
  } catch {
    return []
  }
}

/**
 * Prefer the Session's own directory, then a Client path only when it sits inside a
 * registered workspace, then the deployment default. The Client is never allowed to
 * choose an arbitrary directory.
 */
async function resolveDirectory(ctx, payload) {
  const candidates = []
  const sessionId = payload !== null && typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (sessionId !== '') {
    const live = directoryOf(ctx, agentOf(ctx, sessionId))
    if (live !== undefined) {
      sessionDirs.set(sessionId, live)
      candidates.push(live)
    } else {
      const known = sessionDirs.get(sessionId)
      if (known !== undefined) candidates.push(known)
    }
  }
  if (typeof payload.cwd === 'string' && isAbsolute(payload.cwd)) {
    const allowed = registeredPaths(ctx).some((root) => isInside(root, payload.cwd))
    if (allowed) candidates.push(payload.cwd)
  }
  const workingDirectory = service(ctx, 'workingDirectory')
  if (workingDirectory !== undefined && workingDirectory !== null) {
    try {
      candidates.push(workingDirectory.defaultDirectory)
    } catch {
      // The working-directory service is optional for this route.
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) continue
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

function respond(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise((resolve_, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve_(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function stamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function render(payload, text) {
  const lines = [
    '# 注释片段',
    '',
    `- 采集时间：${new Date().toISOString()}`,
  ]
  if (typeof payload.capturedAt === 'string' && payload.capturedAt !== '') {
    lines.push(`- 选中时间：${payload.capturedAt}`)
  }
  if (typeof payload.sessionId === 'string' && payload.sessionId !== '') {
    lines.push(`- 会话：${payload.sessionId}`)
  }
  lines.push(`- 字符数：${[...text].length}`, '', '---', '', text, '', '---', '')
  lines.push('> 临时注释文件：模型读完本轮内容后自动删除；未被读取的会在 1 小时后清理。')
  return `${lines.join('\n')}\n`
}

async function handler(ctx, req, res) {
  if (req.method !== 'POST') {
    respond(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  // A custom header keeps cross-origin pages from reaching this route through a
  // simple form post; the browser must preflight, and no CORS headers are sent.
  if (req.headers[HEADER] !== '1') {
    respond(res, 403, { ok: false, error: 'forbidden' })
    return
  }

  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch (error) {
    respond(res, error instanceof Error && error.message === 'too-large' ? 413 : 400, { ok: false, error: 'bad-request' })
    return
  }

  const text = payload !== null && typeof payload.text === 'string' ? payload.text.trim() : ''
  if (text === '') {
    respond(res, 400, { ok: false, error: 'empty-selection' })
    return
  }

  const cwd = await resolveDirectory(ctx, payload)
  if (cwd === undefined) {
    respond(res, 400, { ok: false, error: 'no-workspace' })
    return
  }

  const directory = join(cwd, DIRECTORY)
  const name = `${stamp(new Date())}-${Math.random().toString(36).slice(2, 6)}.md`
  const path = join(directory, name)
  try {
    await mkdir(directory, { recursive: true })
    // Keep the scratch directory out of version control without touching the
    // repository's own .gitignore.
    await writeFile(join(directory, '.gitignore'), '*\n', 'utf8').catch(() => undefined)
    await writeFile(path, render(payload, text), 'utf8')
  } catch {
    respond(res, 500, { ok: false, error: 'write-failed' })
    return
  }

  remember(payload, path)

  respond(res, 200, { ok: true, name, path, relative: `${DIRECTORY}/${name}` })
}
