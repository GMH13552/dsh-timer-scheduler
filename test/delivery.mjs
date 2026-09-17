/**
 * Delivery-contract regression test for the host half.
 *
 * The contract under test: a reminder wakes the SAME session that armed it.
 *  - live session            → followup only;
 *  - cold ordinary session   → resume WITH its own persisted preset mounted;
 *  - unusable preset         → parked for manual retry (never re-preset);
 *  - transient resume failure→ bounded backoff retry, never a reroute;
 *  - cold subagent child     → seam delivery via its live direct parent;
 *  - cold subagent child with an offline parent → parked, and the archived
 *    parent session is NEVER resumed or used as a delivery target.
 *
 * Run with: node test/delivery.mjs
 */
import { pathToFileURL } from 'node:url'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build one fake host world, load the plugin into it, and fire one overdue
 * reminder immediately (the plugin re-arms overdue reminders on startup).
 * @param name - case name, used for the isolated DSH_HOME and logging.
 * @param world - session header, live agents, and injectable services.
 * @returns the recorded calls plus the `list_reminders` output.
 */
async function runCase(name, world) {
  const home = mkdtempSync(join(tmpdir(), `timer-${name}-`))
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home

  const calls = { followup: [], resume: [], mount: [], sendMessage: [], delivered: [] }
  let factoryFailures = Number(world.factoryFailures || 0)
  const wrapLive = (agent) => (agent === undefined ? undefined : {
    id: agent.id,
    followup: (message) => {
      calls.followup.push(message)
      calls.delivered.push(message.content[0].text.slice(0, 12))
    },
  })
  const live = wrapLive(world.live)
  const liveParent = wrapLive(world.liveParent)

  // Overdue by default: the plugin re-arms it at startup and fires immediately.
  // A future dueMs seeds a genuinely PENDING entry (for queue-action tests).
  writeFileSync(join(home, 'timer-reminders.json'), JSON.stringify([{
    id: 'r1',
    note: 'check gpu',
    dueMs: Date.now() + Number(world.dueInMs ?? -60_000),
    sessionId: world.header.id,
    parentSession: world.header.parentSession,
    attempts: 0,
    missed: false,
  }]), 'utf8')

  const ctx = {
    get(service) {
      if (service === 'sessions') {
        return { get: (id) => (live !== undefined && id === world.header.id ? { header: world.header } : undefined) }
      }
      if (service === 'sessionQuery') {
        return { observeSession: async (id) => ({ header: id === world.header.id ? world.header : undefined }) }
      }
      if (service === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      }
      if (service === 'agentPresets') {
        return {
          resolve: async (id) => {
            if (id === world.missingPreset) throw new Error(`agent-presets: preset "${id}" not found (available: long-run-router)`)
            return { id: id ?? 'long-run-router' }
          },
          mount: async (agentCtx, id) => { calls.mount.push(id); return { id } },
        }
      }
      if (service === 'subagents') {
        if (world.noSubagentSeam) return undefined
        return {
          sendMessage: async (parent, childId, content, options) => {
            calls.sendMessage.push({ parent: parent.id, childId, text: content[0].text, signalAborted: Boolean(options?.signal?.aborted) })
            return 'message-id'
          },
        }
      }
      return undefined
    },
    agents: {
      get: (id) => {
        if (live !== undefined && id === world.header.id) return live
        if (liveParent !== undefined && id === liveParent.id) return liveParent
        return undefined
      },
      resume: async (options) => {
        calls.resume.push({ resumeSessionId: options.resumeSessionId, agentOptions: options.agentOptions, hasSetup: options.setup !== undefined })
        if (factoryFailures > 0) {
          factoryFailures -= 1
          throw new Error('no agent factory registered (load an agent-loop plugin)')
        }
        const agent = { id: world.header.id, followup: (message) => calls.delivered.push(message.content[0].text.slice(0, 12)) }
        if (options.setup !== undefined) await options.setup({}, agent)
        return { agent, dispose: async () => {} }
      },
    },
    tools: { register: (definition) => { (ctx.__definitions ??= []).push(definition) } },
    inject: (names, callback) => {
      if (!Array.isArray(names) || !names.includes('webServer')) return
      callback({
        webServer: { register: (route) => { calls.route = route; return () => {} } },
        effect: () => {},
      })
    },
    effect: (callback) => callback(),
    on: () => {},
    timeout: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      return () => clearTimeout(handle)
    },
  }

  const module = await import(pathToFileURL(PLUGIN).href)
  module.apply(ctx)
  await sleep(Number(world.waitMs || 300))
  const list = (ctx.__definitions ?? []).find((definition) => definition.name === 'list_reminders')
  const listOutput = list === undefined ? '' : await list.execute({})
  calls.listOutput = listOutput
  calls.tools = {
    schedule: (ctx.__definitions ?? []).find((definition) => definition.name === 'schedule_reminder'),
    list,
    retry: (ctx.__definitions ?? []).find((definition) => definition.name === 'retry_reminder'),
    cancel: (ctx.__definitions ?? []).find((definition) => definition.name === 'cancel_reminder'),
  }
  /** Drive the browser-facing route exactly as the header menu does. */
  calls.post = async (query) => {
    let status = 0
    let body = ''
    await calls.route.handler(
      { method: 'POST', url: '/api/timer-reminders?' + query },
      { writeHead: (code) => { status = code }, end: (payload) => { body = payload } },
    )
    await sleep(60)
    return { status, body: JSON.parse(body) }
  }
  return calls
}

// ── 1. live session: followup only, nothing resumed ─────────────────────────
{
  console.log('case: live session')
  const calls = await runCase('live', {
    header: { id: 's-live', agentPreset: 'long-run-router' },
    live: { id: 's-live' },
  })
  check('delivered to the live agent', calls.delivered.length === 1, JSON.stringify(calls))
  check('did NOT cold-resume a live session', calls.resume.length === 0, JSON.stringify(calls.resume))
}

// ── 2. cold forked session: resume with its own preset mounted ──────────────
{
  console.log('case: cold forked session')
  const calls = await runCase('cold-fork', {
    header: { id: 's-fork', parentSession: 's-main', isSeeded: true, agentPreset: 'long-run-router' },
  })
  check('resumed the same session id', calls.resume.length === 1 && calls.resume[0].resumeSessionId === 's-fork', JSON.stringify(calls.resume))
  check('passed a factory setup (preset mount)', calls.resume[0]?.hasSetup === true, JSON.stringify(calls.resume))
  check('mounted the session\'s OWN persisted preset', calls.mount.length === 1 && calls.mount[0] === 'long-run-router', JSON.stringify(calls.mount))
  check('delivered the reminder after resume', calls.delivered.length === 1, JSON.stringify(calls.delivered))
  check('passed the default model selection', calls.resume[0]?.agentOptions?.model === 'deepseek-chat', JSON.stringify(calls.resume))
  check('never touched the fork-lineage parent session', calls.sendMessage.length === 0, JSON.stringify(calls.sendMessage))
}

// ── 3. the session's preset was deleted: park, never re-preset ──────────────
{
  console.log('case: deleted preset')
  const calls = await runCase('missing-preset', {
    header: { id: 's-gone', agentPreset: 'deleted-preset' },
    missingPreset: 'deleted-preset',
  })
  check('did NOT resume under a different composition', calls.resume.length === 0, JSON.stringify(calls.resume))
  check('parked for manual retry', calls.listOutput.includes('等待人工重试'), calls.listOutput)
  check('named the unavailable preset', calls.listOutput.includes('deleted-preset'), calls.listOutput)
  check('nothing was delivered', calls.delivered.length === 0, JSON.stringify(calls.delivered))
}

// ── 4. transient factory-missing failure: backoff retry, no reroute ────────
{
  console.log('case: transient factory-missing failure')
  const calls = await runCase('factory-late', {
    header: { id: 's-late', agentPreset: 'long-run-router' },
    factoryFailures: 1,
    waitMs: 3000,
  })
  check('retried the SAME session after the failure', calls.resume.length === 2 && calls.resume.every((entry) => entry.resumeSessionId === 's-late'), JSON.stringify(calls.resume))
  check('the retry carried the preset mount', calls.mount.length === 1, JSON.stringify(calls.mount))
  check('delivered after the retry', calls.delivered.length === 1, JSON.stringify(calls.delivered))
  check('never rerouted to another session', calls.sendMessage.length === 0, JSON.stringify(calls.sendMessage))
}

// ── 5. cold subagent child, direct parent offline: park, never parent-wake ──
{
  console.log('case: cold subagent child with offline parent')
  const calls = await runCase('subagent-orphan', {
    header: { id: 'child-1', origin: 'subagent', parentSession: 's-main' },
  })
  check('did NOT root-resume the child', calls.resume.length === 0, JSON.stringify(calls.resume))
  check('did NOT deliver through the seam', calls.sendMessage.length === 0, JSON.stringify(calls.sendMessage))
  check('parked for manual retry', calls.listOutput.includes('等待人工重试'), calls.listOutput)
  check('explained which parent is offline', calls.listOutput.includes('s-main'), calls.listOutput)
}

// ── 6. cold subagent child, direct parent live: seam delivery ───────────────
{
  console.log('case: cold subagent child with live parent')
  const calls = await runCase('subagent-live-parent', {
    header: { id: 'child-2', origin: 'subagent', parentSession: 's-parent-live' },
    liveParent: { id: 's-parent-live' },
  })
  check('delivered through ctx.subagents.sendMessage', calls.sendMessage.length === 1, JSON.stringify(calls.sendMessage))
  check('sent from the exact live direct parent', calls.sendMessage[0]?.parent === 's-parent-live', JSON.stringify(calls.sendMessage))
  check('targeted the same child id', calls.sendMessage[0]?.childId === 'child-2', JSON.stringify(calls.sendMessage))
  check('did NOT root-resume the child', calls.resume.length === 0, JSON.stringify(calls.resume))
  check('delivered a real reminder text', String(calls.sendMessage[0]?.text || '').includes('定时提醒'), JSON.stringify(calls.sendMessage))
}

// ── 7. a repeated schedule for the same note/minute is reused, not stacked ──
{
  console.log('case: duplicate schedule is reused')
  const calls = await runCase('duplicate-schedule', {
    header: { id: 's-dup', agentPreset: 'long-run-router' },
    live: { id: 's-dup' },
  })
  const agent = { id: 's-dup', session: { header: { parentSession: undefined } } }
  const first = await calls.tools.schedule.execute({ note: 'same check', delay_seconds: 3600 }, { agent })
  const second = await calls.tools.schedule.execute({ note: 'same check', delay_seconds: 3600 }, { agent })
  check('first schedule created an entry', first.includes('已设定时提醒'), first)
  check('second schedule reused it', second.includes('复用已存在的定时提醒'), second)
  const rows = await calls.tools.list.execute({})
  check('only one reminder is pending', rows.includes('1 条'), rows)
}

// ── 8. the header menu can push a queued reminder out (and cancel it) ───────
{
  console.log('case: menu retry / cancel actions')
  // A future entry: pending, untouched by the startup re-arm.
  const pending = await runCase('menu-retry', {
    header: { id: 's-menu', agentPreset: 'long-run-router' },
    live: { id: 's-menu' },
    dueInMs: 3600_000,
  })
  check('a queue-action route is registered', typeof pending.route?.handler === 'function')
  const wrongSession = await pending.post('action=cancel&id=r1&sessionId=someone-else')
  check('another session cannot act on it', wrongSession.status === 403, JSON.stringify(wrongSession))
  const unknown = await pending.post('action=retry&id=nope&sessionId=s-menu')
  check('an unknown id answers 404', unknown.status === 404, JSON.stringify(unknown))
  const pushed = await pending.post('action=retry&id=r1&sessionId=s-menu')
  check('retry is accepted', pushed.status === 200 && pushed.body.ok === true, JSON.stringify(pushed))
  check('retry delivered to the SAME session right away', pending.delivered.length === 1, JSON.stringify(pending.delivered))
  check('the delivered entry left the queue', (await pending.tools.list.execute({})).includes('暂无待触发'), await pending.tools.list.execute({}))

  const toCancel = await runCase('menu-cancel', {
    header: { id: 's-cancel', agentPreset: 'long-run-router' },
    live: { id: 's-cancel' },
    dueInMs: 3600_000,
  })
  const cancelled = await toCancel.post('action=cancel&id=r1&sessionId=s-cancel')
  check('cancel is accepted', cancelled.status === 200 && cancelled.body.action === 'cancel', JSON.stringify(cancelled))
  check('cancelled entry is gone from the queue', (await toCancel.tools.list.execute({})).includes('暂无待触发'), await toCancel.tools.list.execute({}))
  check('cancel injected nothing', toCancel.delivered.length === 0, JSON.stringify(toCancel.delivered))
}

console.log(failures === 0 ? '\nall delivery-contract cases passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
