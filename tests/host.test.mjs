/**
 * Strict Host-half verification.
 *
 * Layers:
 *   1. invariants asserted directly against the running module;
 *   2. a model-based random walk over 300 operations, where the model mirrors the
 *      documented rules and must agree with disk after every step;
 *   3. sweep rules, restart behaviour, and an HTTP surface fuzz.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const module_ = await import(new URL('../index.js', import.meta.url))

const failures = []
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition !== true) failures.push({ label, detail })
}

const root = await mkdtemp(join(tmpdir(), 'dsh-strict-'))
const outside = await mkdtemp(join(tmpdir(), 'dsh-strict-outside-'))
const dir = join(root, '.dsh-annotations')
const handlers = {}

const services = {
  workspaceRegistry: { list: () => [{ id: 'w', path: root }] },
  workingDirectory: { get: () => root, defaultDirectory: root },
  agents: { get: (id) => ({ id, session: { id, header: { cwd: root } } }) },
}
module_.apply({
  effect(fn) { return fn() },
  on(name, fn) { handlers[name] = fn; return () => {} },
  get(name) { return services[name] },
  webServer: { register(route) { handlers.route = route; return () => {} } },
})

function request(body, options = {}) {
  const { method = 'POST', header = true } = options
  const source = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  const req = Readable.from([source])
  req.method = method
  req.headers = header ? { 'x-dsh-quoted': '1' } : {}
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { resolve({ status: res.statusCode, body: text === undefined || text === '' ? undefined : JSON.parse(text) }) },
    }
    handlers.route.handler(req, res)
  })
}
const post = (payload, options) => request(JSON.stringify(payload), options)
const fire = (name, payload) => handlers[name](payload)
const agentOf = (id) => ({ id, session: { id, header: { cwd: root } } })
const listFiles = async () => (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.md'))

// The model mirrors the documented rules exactly.
const tracked = new Map()      // sessionId → Set(path)
const readKeys = new Set()     // `${sessionId}:${path}`
const owned = new Map()        // sessionId → Set(path) snapshot

function beginTurn(sessionId) {
  if (owned.has(sessionId)) return
  owned.set(sessionId, new Set(tracked.get(sessionId) ?? []))
}
function endTurn(sessionId) {
  const files = tracked.get(sessionId) ?? new Set()
  const snapshot = owned.get(sessionId)
  owned.delete(sessionId)
  const scope = snapshot ?? new Set(files)
  for (const path of [...files]) {
    if (!scope.has(path)) continue
    if (!readKeys.has(`${sessionId}:${path}`)) continue
    files.delete(path)
  }
}

async function create(sessionId, text) {
  const created = await post({ text, cwd: root, sessionId })
  if (created.status === 200) {
    const files = tracked.get(sessionId) ?? new Set()
    files.add(created.body.path)
    tracked.set(sessionId, files)
  }
  return created
}

// ---------------------------------------------------------------- invariants
{
  const a = await create('s1', 'read me')
  beginTurn('s1')
  fire('tools/result', { name: 'read', arguments: { file_path: a.body.path }, agent: agentOf('s1') })
  readKeys.add(`s1:${a.body.path}`)
  await fire('agent/turn-stopping', { agent: agentOf('s1'), turn: 1 })
  endTurn('s1')
  check('a read file owned by the turn is deleted', (await listFiles()).includes(a.body.name) === false, await listFiles())

  const unread = await create('s1', 'never read')
  beginTurn('s1')
  await fire('agent/turn-stopping', { agent: agentOf('s1'), turn: 2 })
  endTurn('s1')
  check('an unread file survives its turn', (await listFiles()).includes(unread.body.name) === true, await listFiles())

  // Two sessions in one workspace: closing one must not touch the other's draft.
  const draft1 = await create('s1', 's1 draft')
  const draft2 = await create('s2', 's2 draft')
  fire('tools/result', { name: 'read', arguments: { file_path: draft2.body.path }, agent: agentOf('s2') })
  readKeys.add(`s2:${draft2.body.path}`)
  beginTurn('s2')
  await fire('agent/turn-stopping', { agent: agentOf('s2'), turn: 1 })
  endTurn('s2')
  const after = await listFiles()
  check('another session\'s draft is untouched', after.includes(draft1.body.name) === true, after)
  check('the other session\'s own file is gone', after.includes(draft2.body.name) === false, after)
}

// ---------------------------------------------------------------- random walk
{
  await rm(dir, { recursive: true, force: true })
  tracked.clear()
  readKeys.clear()
  owned.clear()

  let seed = 20261018
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const sessions = ['a', 'b', 'c']
  let diverged = null

  for (let step = 0; step < 300 && diverged === null; step += 1) {
    const pick = random()
    const sessionId = sessions[Math.floor(random() * sessions.length)]

    if (pick < 0.45) {
      await create(sessionId, `text ${step}`)
    } else if (pick < 0.62) {
      beginTurn(sessionId)
      fire('agent/inbox/claimed', { agent: agentOf(sessionId), message: {}, turn: step })
    } else if (pick < 0.78) {
      const files = [...(tracked.get(sessionId) ?? [])]
      if (files.length > 0) {
        const target = files[Math.floor(random() * files.length)]
        fire('tools/result', { name: 'read', arguments: { file_path: target }, agent: agentOf(sessionId) })
        readKeys.add(`${sessionId}:${target}`)
      }
    } else if (pick < 0.92) {
      await fire('agent/turn-stopping', { agent: agentOf(sessionId), turn: step })
      endTurn(sessionId)
    } else {
      fire('agent/status', { agent: agentOf(sessionId), status: 'idle' })
      owned.delete(sessionId)
    }

    const expected = new Set()
    for (const files of tracked.values()) for (const path of files) expected.add(path)
    const actual = new Set((await listFiles()).map((name) => join(dir, name)))
    const missing = [...expected].filter((path) => !actual.has(path))
    const extra = [...actual].filter((path) => !expected.has(path))
    if (missing.length > 0 || extra.length > 0) diverged = { step, missing, extra }
  }

  check('disk and model agree across 300 random operations', diverged === null, diverged)
}

// ---------------------------------------------------------------- sweep rules
{
  await writeFile(join(dir, 'aged.md'), 'old', 'utf8')
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(join(dir, 'aged.md'), twoHoursAgo, twoHoursAgo)
  const agent = agentOf('z')
  beginTurn('z')
  await fire('agent/turn-stopping', { agent, turn: 1 })
  endTurn('z')
  check('an aged untracked file is swept', (await listFiles()).includes('aged.md') === false, await listFiles())

  const kept = await create('z', 'tracked old')
  await utimes(kept.body.path, twoHoursAgo, twoHoursAgo)
  beginTurn('z')
  await fire('agent/turn-stopping', { agent, turn: 2 })
  endTurn('z')
  check('an aged but tracked file is not swept', (await listFiles()).includes(kept.body.name) === true, await listFiles())
}

// ---------------------------------------------------------------- restart sweep
{
  const freshRoot = await mkdtemp(join(tmpdir(), 'dsh-strict-restart-'))
  const freshDir = join(freshRoot, '.dsh-annotations')
  await mkdir(freshDir, { recursive: true })
  const handlersFresh = {}
  const freshServices = {
    workspaceRegistry: { list: () => [{ path: freshRoot }] },
    workingDirectory: { get: () => freshRoot, defaultDirectory: freshRoot },
    agents: { get: () => undefined },
  }
  const fresh = await import(new URL(`../index.js?restart=${Date.now()}`, import.meta.url))
  fresh.apply({
    effect(fn) { return fn() },
    on(name, fn) { handlersFresh[name] = fn; return () => {} },
    get(name) { return freshServices[name] },
    webServer: { register(route) { handlersFresh.route = route; return () => {} } },
  })

  await writeFile(join(freshDir, 'orphan.md'), 'old', 'utf8')
  await writeFile(join(freshDir, 'fresh.md'), 'new', 'utf8')
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
  await utimes(join(freshDir, 'orphan.md'), threeHoursAgo, threeHoursAgo)

  await new Promise((resolve) => setTimeout(resolve, 5600))
  const left = (await readdir(freshDir)).filter((name) => name.endsWith('.md'))
  check('the startup sweep drops only the aged orphan', left.includes('orphan.md') === false && left.includes('fresh.md') === true, left)
  await rm(freshRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------- HTTP surface
{
  const wrongMethod = await request('{}', { method: 'GET' })
  check('GET is rejected with 405', wrongMethod.status === 405, wrongMethod)

  const noHeader = await post({ text: 'x', cwd: root }, { header: false })
  check('a missing header is rejected with 403', noHeader.status === 403, noHeader)

  const badJson = await request('{not json')
  check('malformed JSON is rejected with 400', badJson.status === 400 && badJson.body?.error === 'bad-request', badJson)

  const blank = await post({ text: '   ', cwd: root })
  check('blank text is rejected', blank.status === 400 && blank.body?.error === 'empty-selection', blank)

  const huge = await post({ text: 'a'.repeat(300 * 1024), cwd: root })
  check('an oversize body is rejected with 413', huge.status === 413, huge)

  const escape = await post({ text: 'escape', cwd: outside, sessionId: 'ghost' })
  const outsideFiles = await readdir(join(outside, '.dsh-annotations')).catch(() => [])
  check('a client cwd outside the workspace cannot receive the file', outsideFiles.length === 0, { escape, outsideFiles })

  const nul = await post({ text: 'a\u0000b', cwd: root, sessionId: 'nul' })
  check('a NUL byte in the text does not break the write', nul.status === 200, nul)

  const emoji = await post({ text: '👨‍👩‍👧‍👦', cwd: root, sessionId: 'emoji' })
  const emojiBody = await import('node:fs/promises').then(({ readFile }) => readFile(emoji.body.path, 'utf8'))
  check('astral characters round-trip through the file', emojiBody.includes('👨‍👩‍👧‍👦'), emojiBody)
}

for (const failure of failures) console.log(`FAIL  ${failure.label}  → ${JSON.stringify(failure.detail)}`)
console.log(`\n${checks - failures.length}/${checks} checks passed`)

await rm(root, { recursive: true, force: true })
await rm(outside, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
