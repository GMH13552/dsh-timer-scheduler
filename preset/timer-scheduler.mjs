/**
 * timer-scheduler — a persistent, one-shot reminder toolset for the agent.
 *
 * Registers three model-facing tools (`schedule_reminder`, `list_reminders`,
 * `cancel_reminder`) plus an auto-wake mechanism: when a timer fires, the
 * plugin delivers a `user` message to the owning agent via `agent.followup()`,
 * so the agent autonomously checks on the task without the human prompting it.
 *
 * Persistence: pending reminders are serialized to
 * `$DSH_HOME/timer-reminders.json` (keyed by the owning session id). On plugin
 * startup the file is re-read and every still-future reminder is re-armed, so a
 * process restart does not lose them. At fire time the agent is re-resolved
 * through `ctx.agents.get(sessionId)`; a reminder whose session is not live
 * (cold, not re-opened since restart) is skipped with a warning instead of
 * being silently dropped — cold-resume is deliberately out of scope here.
 *
 * Plane: this is an AGENT-PLANE plugin. It registers tools and consumes the
 * host `tools`/`timer`/`agents` services; it publishes no service of its own,
 * so it needs no `isolate` realm and may sit loose in a preset.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'timer-scheduler'

/** tools/timer/agents are host-plane services this plugin only consumes. */
export const inject = ['tools', 'timer', 'agents']

/** Largest delay Node timers accept before overflowing (~24.8 days). */
const MAX_TIMEOUT = 2147483647

/** Stable base directory for the reminder file (DSH home first, then ~/.dsh). */
function baseDir() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  if (typeof process.env.HOME === 'string' && process.env.HOME.length > 0) return join(process.env.HOME, '.dsh')
  return process.cwd()
}

function reminderFile() {
  return join(baseDir(), 'timer-reminders.json')
}

/** Read persisted reminders, tolerating a missing or malformed file. */
function loadReminders() {
  try {
    const data = JSON.parse(readFileSync(reminderFile(), 'utf8'))
    if (!Array.isArray(data)) return []
    return data.filter((r) =>
      r !== null && typeof r === 'object'
      && typeof r.id === 'string' && r.id.length > 0
      && typeof r.note === 'string'
      && typeof r.dueMs === 'number' && Number.isFinite(r.dueMs)
      && typeof r.sessionId === 'string' && r.sessionId.length > 0,
    )
  } catch {
    return []
  }
}

function saveReminders(list) {
  try {
    mkdirSync(baseDir(), { recursive: true })
    writeFileSync(reminderFile(), JSON.stringify(list), 'utf8')
  } catch (err) {
    console.error('timer-scheduler: failed to persist reminders:', err)
  }
}

export function apply(ctx) {
  /** id -> { id, note, dueMs, sessionId, cancel } */
  const pending = new Map()
  let seq = 0

  function makeId() {
    seq += 1
    return 'sched-' + Date.now().toString(36) + '-' + seq.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  }

  function iso(ms) {
    return new Date(ms).toISOString()
  }

  function persist() {
    const list = []
    for (const entry of pending.values()) {
      list.push({ id: entry.id, note: entry.note, dueMs: entry.dueMs, sessionId: entry.sessionId })
    }
    saveReminders(list)
  }

  function fire(entry) {
    if (pending.delete(entry.id)) persist()
    const agent = ctx.agents.get(entry.sessionId)
    if (agent === undefined) {
      console.warn(`timer-scheduler: session ${entry.sessionId} is not live; reminder skipped: ${entry.note}`)
      return
    }
    const note = entry.note
    const summary = '\u23F0 ' + (note.length > 110 ? note.slice(0, 109) + '\u2026' : note)
    const text = '\u23F0 定时提醒触发（这是你之前给自己安排的检查）：\n\n' + note + '\n\n现在请自主去查看/处理这件事，完成后向用户汇报结果。'
    const message = {
      id: makeId(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'timer-scheduler', form: 'notice', summary },
    }
    try {
      agent.followup(message)
      console.log(`timer-scheduler: fired reminder ${JSON.stringify(summary)}`)
    } catch (err) {
      console.error('timer-scheduler: failed to deliver reminder:', err)
    }
  }

  /** Arm one reminder with a chunked timer that re-arms until due. */
  function arm(entry) {
    function tick() {
      const remaining = entry.dueMs - Date.now()
      if (remaining <= 0) {
        entry.cancel = null
        fire(entry)
        return
      }
      entry.cancel = ctx.timeout(tick, Math.min(remaining, MAX_TIMEOUT))
    }
    tick()
  }

  function schedule(note, dueMs, sessionId) {
    const entry = { id: makeId(), note, dueMs, sessionId, cancel: null }
    pending.set(entry.id, entry)
    persist()
    arm(entry)
    return entry
  }

  function cancelEntry(id) {
    const entry = pending.get(id)
    if (entry === undefined) return false
    if (typeof entry.cancel === 'function') entry.cancel()
    pending.delete(id)
    persist()
    return true
  }

  // Re-arm persisted reminders on startup.
  const now = Date.now()
  for (const r of loadReminders()) {
    if (r.dueMs <= now) continue
    const entry = { id: r.id, note: r.note, dueMs: r.dueMs, sessionId: r.sessionId, cancel: null }
    pending.set(entry.id, entry)
    arm(entry)
  }

  function parseClock(s, nowMs) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
    if (m === null) return undefined
    const h = parseInt(m[1], 10)
    const min = parseInt(m[2], 10)
    const sec = m[3] === undefined ? 0 : parseInt(m[3], 10)
    if (h > 23 || min > 59 || sec > 59) throw new Error('Invalid clock time: ' + s)
    const d = new Date(nowMs)
    d.setHours(h, min, sec, 0)
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1)
    return d.getTime()
  }

  function parseDue(args) {
    const nowMs = Date.now()
    if (typeof args.delay_seconds === 'number' && Number.isFinite(args.delay_seconds)) {
      if (args.delay_seconds < 0) throw new Error('delay_seconds must be >= 0')
      return nowMs + args.delay_seconds * 1000
    }
    if (typeof args.at === 'string' && args.at.trim() !== '') {
      const s = args.at.trim()
      const clock = parseClock(s, nowMs)
      if (clock !== undefined) return clock
      const t = Date.parse(s)
      if (Number.isFinite(t)) return t
      throw new Error('Cannot parse absolute time: ' + s + ' (use ISO 8601 or HH:MM[:SS])')
    }
    throw new Error('Provide delay_seconds (relative seconds) or at (absolute time).')
  }

  ctx.tools.register({
    name: 'schedule_reminder',
    description: 'Schedule a one-shot timer that will wake YOU (the agent) at a future time so you can autonomously check on a long-running background job, a remote task, or anything that needs attention later, without the user having to wake you. Use delay_seconds for a relative wait, or at for an absolute clock time. When it fires you receive a new turn carrying the note and should act on it and report back.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'What to check or do when the timer fires. Be specific (include the job id, URL, or file) so future-you knows exactly what to inspect and report.' },
        delay_seconds: { type: 'number', description: 'Relative delay in seconds from now (300 = 5 min, 3600 = 1 hour, 7200 = 2 hours). Use EITHER this OR at.' },
        at: { type: 'string', description: 'Absolute time: ISO 8601 datetime ("2026-08-15T14:30:00") or 24h clock "HH:MM[:SS]" (today; if already past, tomorrow). Use EITHER this OR delay_seconds.' },
      },
      required: ['note'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) throw new Error('No agent available to schedule a reminder for.')
      const dueMs = parseDue(args)
      if (dueMs <= Date.now() + 500) throw new Error('Scheduled time is in the past (or too soon). Provide a future delay_seconds or at.')
      const entry = schedule(String(args.note), dueMs, agent.id)
      return `已设定时提醒 ${entry.id}\n到点: ${iso(entry.dueMs)}\n约 ${Math.round((entry.dueMs - Date.now()) / 1000)}s 后触发`
    },
  })

  ctx.tools.register({
    name: 'list_reminders',
    description: 'List all pending scheduled reminders (timers) that will wake you in the future.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const nowMs = Date.now()
      const items = []
      for (const e of pending.values()) {
        const remain = Math.max(0, Math.round((e.dueMs - nowMs) / 1000))
        items.push(`- ${e.id} 到点 ${iso(e.dueMs)}（约 ${remain}s）\n  ${e.note}`)
      }
      return items.length === 0 ? '暂无待触发的定时提醒' : `待触发的定时提醒（${items.length} 条）:\n${items.join('\n')}`
    },
  })

  ctx.tools.register({
    name: 'cancel_reminder',
    description: 'Cancel a pending scheduled reminder by its id (get ids from list_reminders).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The reminder id to cancel.' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (cancelEntry(args.id)) return `已取消提醒 ${args.id}`
      return `未找到待触发的提醒 ${args.id}`
    },
  })
}
