/**
 * Client-half regression test: loads `lib/client.js` exactly the way the
 * browser module loader does (a `__ModuleLoader__.load` bootstrap + a stubbed
 * `react`), then renders one reminder row and asserts the manual controls the
 * user actually clicks: the 补触发 / 取消 buttons and the 立刻触发 tooltip.
 *
 * No browser, no DSH, no network. Run with: node test/client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
function check(label, condition, detail) {
  if (condition) { console.log(`  ok   ${label}`); return }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── stub browser globals the bundle touches at load time ────────────────────
const loaded = []
const styleTags = []
globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } }
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => styleTags.push(tag) },
}

// ── evaluate the bundle ────────────────────────────────────────────────────
const run = new Function('window', 'document', 'console', source)
run(globalThis.window, globalThis.document, console)

check('bundle registers itself through the module loader', loaded.length === 1, JSON.stringify(loaded.length))
const spec = loaded[0] ?? {}
check('registration carries the plugin id', spec.id === 'dsh-timer-scheduler-ui', String(spec.id))

// ── run the factory with a stubbed `react` ─────────────────────────────────
const REMINDERS = [{
  id: 'sched-test-1',
  note: 'check gpu',
  dueMs: Date.now() + 3600_000,
  missed: false,
  attempts: 0,
  deliveryUncertain: false,
  networkBlocked: false,
  needsManualRetry: false,
  lastError: null,
}]
let useStateCall = 0
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    useStateCall += 1
    // 1: reminders, 2: now, 3: menu open (render the rows), 4: menu style
    if (useStateCall === 1) return [REMINDERS, () => {}]
    if (useStateCall === 2) return [Date.now(), () => {}]
    if (useStateCall === 3) return [true, () => {}]
    if (useStateCall === 4) return [{ top: 10, left: 10, width: 300 }, () => {}]
    return [initial, () => {}]
  },
  useRef: (initial) => ({ current: initial ?? null }),
  useEffect: () => {},
}

// The bundle builds its own `module` and returns the exports object.
const client = spec.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
})

check('factory exports an inject list', Array.isArray(client?.inject), JSON.stringify(client?.inject))
check('inject list keeps slots/timer/sessions',
  Array.isArray(client?.inject) && ['slots', 'timer', 'sessions'].every((s) => client.inject.includes(s)),
  JSON.stringify(client?.inject))
check('factory exports apply()', typeof client?.apply === 'function')

// ── drive apply() and capture the registered slot component ────────────────
let registration
const ctx = {
  slots: {
    inject: (name, callback) => { if (name === 'conversation.session.header.actions') callback(ctx.slots) },
    register: (options, component) => { registration = { options, component }; return () => {} },
  },
}
client.apply(ctx)
check('registers one session-header slot', registration !== undefined)
check('slot id/order are stable', registration?.options?.id === 'timer-scheduler' && registration?.options?.order === 30,
  JSON.stringify(registration?.options))
check('styles are injected once', styleTags.length === 1, String(styleTags.length))

// ── render the row and inspect the buttons ─────────────────────────────────
const tree = registration.component()
const buttons = []
const walk = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node.type === 'function') { walk(node.type(node.props ?? {})); return }
  if (node.type === 'button') buttons.push(node)
  walk(node.children)
}
walk(tree)
// The header trigger is a button too; the row controls are the ones whose label
// is a plain string child.
const rowButtons = buttons.filter((b) => typeof b.children?.[0] === 'string')
check('row renders exactly the two manual controls', rowButtons.length === 2,
  JSON.stringify(buttons.map((b) => (b.children ?? []).map((c) => (typeof c === 'string' ? c : `<${c?.type}>`)).join(''))))
check('fire button is labelled 补触发', rowButtons[0]?.children?.[0] === '补触发', JSON.stringify(rowButtons[0]?.children))
check('fire button tooltip is exactly 立刻触发', rowButtons[0]?.props?.title === '立刻触发', JSON.stringify(rowButtons[0]?.props?.title))
check('cancel button is labelled 取消', rowButtons[1]?.children?.[0] === '取消', JSON.stringify(rowButtons[1]?.children))
check('both controls are type=button', rowButtons.every((b) => b.props?.type === 'button'))
check('both controls carry click handlers', rowButtons.every((b) => typeof b.props?.onClick === 'function'))

console.log(failures === 0 ? '\nall client-half cases passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
