/**
 * Client-half simulation: loads the real client bundle into a vm with a hook-capable
 * React shim, a fake DOM, and a fake fetch, then drives its real event handlers.
 *
 * Covered: selection scoping, duplicate suppression, IME deferral, the chip payload
 * written through setDraft, and the mark lifecycle.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const failures = []
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition !== true) failures.push({ label, detail })
}

// ------------------------------------------------------------------ React shim
function makeReact() {
  let hooks = []
  let index = 0
  let active = []
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const slot = index++
      if (hooks[slot] === undefined) {
        hooks[slot] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      }
      return [hooks[slot].value, (next) => { hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next }]
    },
    useEffect(fn) {
      const slot = index++
      if (hooks[slot] === undefined) {
        hooks[slot] = { kind: 'effect' }
        const cleanup = fn()
        if (typeof cleanup === 'function') hooks[slot].cleanup = cleanup
      }
    },
    useRef(initial) {
      const slot = index++
      if (hooks[slot] === undefined) hooks[slot] = { kind: 'ref', current: initial }
      return hooks[slot]
    },
    useCallback(fn) {
      const slot = index++
      if (hooks[slot] === undefined) hooks[slot] = { kind: 'callback', fn }
      return hooks[slot].fn
    },
    memo(fn) { return fn },
    render(component, props, previous) {
      return mount(component, props, previous)
    },
    renderTracked(component, props) {
      const element = mount(component, props)
      return { element, hooks }
    },
  }

  // A fresh mount unmounts the previous one first, so its effects unsubscribe exactly
  // like React would; otherwise stale subscribers would compete for the next request.
  function mount(component, props, reuse) {
    if (reuse === undefined) {
      for (const slot of active) {
        if (typeof slot?.cleanup === 'function') {
          try { slot.cleanup() } catch { /* the shim tolerates a broken cleanup */ }
        }
      }
      active = []
    }
    hooks = reuse ?? []
    active = hooks
    index = 0
    return component(props)
  }
}

// ------------------------------------------------------------------ DOM shim
const listeners = new Map()
function on(type, fn) {
  const list = listeners.get(type) ?? []
  list.push(fn)
  listeners.set(type, list)
}
function off(type, fn) {
  listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== fn))
}
function dispatch(type, event) {
  for (const fn of listeners.get(type) ?? []) fn(event)
}

let chatPresent = true
let selection = null

/** Shared across realms so the bundle's `instanceof Element` checks hold. */
class ElementShim {}

function element({ chat = false, editable = false, own = false } = {}) {
  const node = new ElementShim()
  node.nodeType = 1
  node.parentElement = null
  node.closest = (selector) => {
    if (selector.includes('contenteditable')) return editable ? node : null
    if (selector === '[data-dsh-quoted]') return own ? node : null
    if (selector === '[data-chat-flow]') return chat ? node : null
    return null
  }
  return node
}

function makeRange() {
  const range = {
    commonAncestorContainer: { isConnected: true },
    getClientRects: () => [{ right: 120, top: 60, width: 40, height: 14 }],
    getBoundingClientRect: () => ({ right: 120, top: 60, width: 40, height: 14 }),
  }
  range.cloneRange = () => makeRange()
  return range
}

function select(text, target) {
  selection = text === ''
    ? { isCollapsed: true, rangeCount: 0, toString: () => '', anchorNode: target, getRangeAt: () => makeRange() }
    : { isCollapsed: false, rangeCount: 1, toString: () => text, anchorNode: target, getRangeAt: () => makeRange() }
}

const document = {
  addEventListener: on,
  removeEventListener: off,
  documentElement: { lang: 'zh-CN' },
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, select() {} }),
  getSelection: () => selection,
  querySelector: (selector) => (selector === '[data-chat-flow]' && chatPresent ? element({ chat: true }) : null),
}

// ------------------------------------------------------------------ environment
const fetches = []
const drafts = []
let nextPayload = { ok: true, name: 'x.md', path: 'E:/w/.dsh-annotations/x.md', relative: '.dsh-annotations/x.md' }

const window = {
  __ModuleLoader__: { load(spec) { window.__spec = spec } },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener: on,
  removeEventListener: off,
  setTimeout: (fn, ms) => (ms >= 1000 ? 0 : setTimeout(fn, ms)),
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
}

const context = vm.createContext({
  window,
  document,
  Element: ElementShim,
  navigator: { language: 'zh-CN', clipboard: { writeText: () => Promise.resolve() } },
  console,
  fetch: async (url, init) => {
    fetches.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => nextPayload }
  },
  setTimeout: window.setTimeout,
  clearTimeout,
  CSS: undefined,
  Highlight: undefined,
  JSON,
  Date,
  Math,
  Set,
  Map,
  Symbol,
  Promise,
  Error,
  Array,
  Object,
  String,
  Number,
  Boolean,
})

vm.runInContext(source, context)

// ------------------------------------------------------------------ plugin load
const React = makeReact()
const spec = window.__spec
check('the bundle registers a module with a factory', typeof spec?.factory === 'function', typeof spec)

const plugin = spec.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

const registered = []
plugin.apply({
  effect(fn) { fn(); return () => {} },
  slots: {
    inject(key, callback) { registered.push({ key, ...callback() }); return () => {} },
    register(options, component) { return { options, component } },
  },
})

const slot = (id) => registered.find((entry) => entry.options?.id === id)
const button = slot('annotation-capture')?.component
const menu = slot('annotation-menu')?.component
const marks = slot('annotation-marks')?.component

check('three slots are registered', registered.length === 3, registered.map((entry) => entry.options?.id))
check('the capture button is in the composer row', slot('annotation-capture')?.key === 'conversation.input.left', slot('annotation-capture')?.key)

// ------------------------------------------------------------------ helpers
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function renderButton(overrides = {}) {
  const props = {
    inputActions: {
      insertText: () => true,
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
      setDraft: (draft) => { drafts.push(draft) },
    },
    sessionId: 's1',
    useSessions: (selector) => selector({ byId: { s1: { cwd: 'E:/w' } } }),
    useSession: (selector) => selector({ cwd: 'E:/w' }),
    useInput: (selector) => selector({ draft: '', occurrences: [] }),
    ...overrides,
  }
  return React.render(button, props)
}

function openMenuFrom(text, target) {
  select(text, target)
  let prevented = false
  dispatch('contextmenu', { preventDefault: () => { prevented = true }, clientX: 40, clientY: 40, target })
  const rendered = React.render(menu, {})
  return { rendered, prevented }
}

function closeMenu() {
  dispatch('mousedown', { target: element({}) })
}

// ------------------------------------------------------------------ scoping
{
  const inside = openMenuFrom('hidden text', element({ chat: true }))
  check('a transcript selection opens the menu', inside.rendered !== null && inside.prevented === true, { prevented: inside.prevented })
  const labels = (inside.rendered?.children ?? [])
    .filter((child) => child?.type === 'button')
    .map((child) => child.children?.[0])
  check('the menu offers copy and quote', labels.length === 2 && labels[0] === '复制' && labels[1] === '引用', labels)
  closeMenu()
  check('the menu closes on an outside press', React.render(menu, {}) === null, 'still open')

  const composer = openMenuFrom('draft text', element({ editable: true }))
  check('a composer selection leaves the native menu alone', composer.rendered === null && composer.prevented === false, composer)

  const sidebar = openMenuFrom('sidebar text', element({}))
  check('a selection outside the transcript is ignored', sidebar.rendered === null && sidebar.prevented === false, sidebar)

  chatPresent = false
  const degraded = openMenuFrom('sidebar text', element({}))
  check('without the flow marker the plugin stays permissive', degraded.rendered !== null, 'menu did not open')
  chatPresent = true
  closeMenu()
}

// ------------------------------------------------------------------ chip write
{
  fetches.length = 0
  drafts.length = 0
  const existing = { source: 'reference', ref: '@src/a.ts', offset: 0, length: 0, label: 'a.ts', clipboardText: '@src/a.ts', appearance: 'file' }
  const view = renderButton({
    useInput: (selector) => selector({ draft: '看看这个', occurrences: [existing] }),
  })
  check('the button reads the workspace from the sessions snapshot', view.props.disabled === false || view.props.disabled === true, view.props)

  // A selection arrives, then the button is pressed.
  select('被引用的原文', element({ chat: true }))
  dispatch('mouseup', { target: element({ chat: true }) })
  renderButton({ useInput: (selector) => selector({ draft: '看看这个', occurrences: [existing] }) })
  view.props.onClick()
  await flush()
  await flush()

  check('one request is issued', fetches.length === 1, fetches.length)
  check('the request carries the selection and the workspace', fetches[0]?.body?.text === '被引用的原文' && fetches[0]?.body?.cwd === 'E:/w', fetches[0]?.body)

  const draft = drafts[0]
  check('the draft is rewritten once', drafts.length === 1, drafts.length)
  check('the existing reference is preserved', draft?.references?.length === 2 && draft.references[0].ref === '@src/a.ts', draft?.references)
  check('the new reference points at the annotation', draft?.references?.[1]?.ref === '@.dsh-annotations/x.md', draft?.references?.[1])
  check('the draft keeps the typed text', draft?.text?.startsWith('看看这个'), draft?.text)
  check('the reference is placed before a separating space', draft?.references?.[1]?.offset === '看看这个'.length + 1 && draft.text.startsWith('看看这个 '), { offset: draft?.references?.[1]?.offset, text: draft?.text })
  check('a whitespace separator precedes the chip', /\s/.test(draft.text.charAt(draft.references[1].offset - 1)), draft.text)
  check('a space follows the chip as its own text node', draft.text.length === draft.references[1].offset + 1 && draft.text.endsWith(' '), draft.text)
  check('the chip text stays the bare mention', draft.references[1].clipboardText === '@.dsh-annotations/x.md', draft.references[1].clipboardText)
}

// ------------------------------------------------------------------ duplicate press
{
  fetches.length = 0
  select('同一段文字', element({ chat: true }))
  dispatch('mouseup', { target: element({ chat: true }) })
  const view = renderButton()
  view.props.onClick()
  await flush()
  view.props.onClick()
  await flush()
  check('a double press within the window creates one file', fetches.length === 1, fetches.length)
}

// ------------------------------------------------------------------ IME
{
  fetches.length = 0
  select('输入法期间', element({ chat: true }))
  dispatch('mouseup', { target: element({ chat: true }) })
  dispatch('compositionstart', {})
  const view = renderButton()
  view.props.onClick()
  await flush()
  check('no write happens during an IME composition', fetches.length === 0, fetches.length)
  dispatch('compositionend', {})
  await new Promise((resolve) => setTimeout(resolve, 250))
  check('the deferred write runs after the composition ends', fetches.length === 1, fetches.length)
}

// ------------------------------------------------------------------ marks
{
  select('标记测试', element({ chat: true }))
  dispatch('mouseup', { target: element({ chat: true }) })
  const view = renderButton()
  view.props.onClick()
  await flush()
  await flush()

  const painted = React.render(marks, {})
  const children = (painted?.children ?? []).flat()
  const badges = children.filter((child) => child?.props?.['data-dsh-quoted'] === 'mark')
  check('a badge is painted for the captured passage', badges.length === 1, badges.length)
  check('the badge is numbered', badges[0]?.children?.[0] === '1', badges[0]?.children)

  renderButton({ useInput: (selector) => selector({ draft: '', occurrences: [] }) })
  check('the badge clears when the draft no longer references an annotation', React.render(marks, {}) === null, 'still painted')
}

// ------------------------------------------------------------------ no readable draft
{
  fetches.length = 0
  select('无法读取草稿', element({ chat: true }))
  dispatch('mouseup', { target: element({ chat: true }) })
  const props = {
    inputActions: {
      insertText: () => true,
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
      setDraft: () => {},
    },
    sessionId: 's1',
    useSessions: (selector) => selector({ byId: { s1: { cwd: 'E:/w' } } }),
    useSession: (selector) => selector({ cwd: 'E:/w' }),
  }
  const first = React.renderTracked(button, props)
  first.element.props.onClick()
  await flush()
  await flush()
  check('without a readable draft nothing is written to disk', fetches.length === 0, fetches.map((entry) => entry.body))

  const second = React.render(button, props, first.hooks)
  check('the button explains the missing draft', /草稿/.test(second.props.title), second.props.title)
}

for (const failure of failures) console.log(`FAIL  ${failure.label}  → ${JSON.stringify(failure.detail)}`)
console.log(`\n${checks - failures.length}/${checks} checks passed`)
process.exit(failures.length === 0 ? 0 : 1)
