/**
 * dsh-timer-scheduler-ui — host half.
 *
 * Registers the three model tools (schedule_reminder / list_reminders /
 * cancel_reminder) plus the GET /api/timer-reminders data route.
 *
 * PLANE: everything here is HOST-plane. This plugin is composed into the web
 * profile's host composition, so the tools are visible to EVERY agent
 * regardless of which preset it runs on, and the route serves the browser.
 *
 * Reminders are persisted to `$DSH_HOME/timer-reminders.json` (keyed by the
 * owning session id) and re-armed on startup.
 *
 * DELIVERY CONTRACT — a reminder always wakes the SAME session that armed it,
 * never a relaunched stand-in:
 *  1. live session → `agent.followup()` (a live agent already carries its tools);
 *  2. cold ordinary session (forked/branched ones included) → `ctx.agents.resume()`
 *     with the session's OWN persisted preset mounted in the factory `setup`, so
 *     the resumed agent gets the composition it was created with. Resuming
 *     without that `setup` composes no tools at all — the `unknown tool "bash"`
 *     failure this plugin used to hit;
 *  3. cold session-backed subagent child → `ctx.subagents.sendMessage()` through
 *     its exact live direct parent, so the continuation seam cold-resumes the
 *     same child with the persona/toolFilter recorded in its descriptor.
 *
 * `header.parentSession` is durable FORK LINEAGE (or a child's direct parent),
 * never a fallback delivery target: re-routing a reminder to a pre-branch or
 * archived parent session is exactly what this contract forbids.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'timer-scheduler-ui'
export const inject = ['tools', 'timer', 'agents']

const MAX_TIMEOUT = 2147483647
/**
 * Bounded backoff for TRANSIENT cold-resume failures: the agent factory is
 * registered by the agent-loop plugin, so a reminder that is overdue at startup
 * can fire before that plugin has loaded, and a session can still be owned by an
 * in-flight write handle during a restart. Neither is a reason to reroute the
 * reminder to another session.
 */
const RESUME_RETRY_DELAYS = [2000, 5000, 15000]
const TRANSIENT_RESUME = /no agent factory registered|already owned by an active write handle|agent factory|not (yet )?(loaded|ready)|timed out/i
/**
 * A cold resume must not wedge a reminder forever: an awaited resume that never
 * settles would leave the entry `delivering` (invisible in the queue, immune to
 * re-arming) with nothing left to push it out. Bounded here, then retried.
 */
const RESUME_TIMEOUT_MS = 90_000

/** Reject a promise that never settles, so a hung step cannot own an entry forever. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

function isNetworkError(err) {
  const code = String((err && (err.code || (err.cause && err.cause.code))) || '')
  const networkCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_SOCKET_CONNECTION_TIMEOUT']
  if (networkCodes.includes(code)) return true
  const msg = String((err && err.message) || err || '').toLowerCase()
  return /network|offline|fetch failed|socket hang up|connection reset|getaddrinfo|dns|timed? ?out|timeout/.test(msg)
}

function home() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  if (typeof process.env.HOME === 'string' && process.env.HOME.length > 0) return join(process.env.HOME, '.dsh')
  return process.cwd()
}

function reminderFile() {
  return join(home(), 'timer-reminders.json')
}

function loadReminders() {
  try {
    const data = JSON.parse(readFileSync(reminderFile(), 'utf8'))
    if (!Array.isArray(data)) return []
    return data.filter((r) =>
      r !== null && typeof r === 'object'
      && typeof r.id === 'string' && r.id.length > 0
      && typeof r.note === 'string'
      && typeof r.dueMs === 'number' && Number.isFinite(r.dueMs)
      && typeof r.sessionId === 'string' && r.sessionId.length > 0)
  } catch {
    return []
  }
}

function saveReminders(list) {
  try {
    mkdirSync(home(), { recursive: true })
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

  function logDeliveryError(kind, sessionId, parentSession, err) {
    try {
      const file = join(home(), 'timer-delivery-errors.jsonl')
      const line = JSON.stringify({
        time: new Date().toISOString(),
        kind,
        sessionId,
        parentSession: parentSession || undefined,
        error: String((err && err.message) || err),
      }) + '\n'
      appendFileSync(file, line, 'utf8')
    } catch { /* diagnostics must never break delivery */ }
  }

  function persist() {
    const list = []
    for (const entry of pending.values()) {
      list.push({ id: entry.id, note: entry.note, dueMs: entry.dueMs, sessionId: entry.sessionId, ...(entry.subject ? { subject: entry.subject } : {}), ...(entry.parentSession ? { parentSession: entry.parentSession } : {}), missed: Boolean(entry.missed), attempts: Number(entry.attempts || 0), lastAttemptAt: entry.lastAttemptAt || null, delivering: Boolean(entry.delivering), deliveryUncertain: Boolean(entry.deliveryUncertain), networkBlocked: Boolean(entry.networkBlocked), needsManualRetry: Boolean(entry.needsManualRetry), immediateRetries: Number(entry.immediateRetries || 0), lastError: entry.lastError || null })
    }
    saveReminders(list)
  }

  /** Cold-resumed AgentHandles, kept so the resumed session can process the wake. */
  const resumed = new Map()

  function fire(entry) {
    if (entry.delivering) return
    entry.delivering = true
    entry.attempts = Number(entry.attempts || 0) + 1
    entry.lastAttemptAt = Date.now()
    entry.deliveryUncertain = false
    persist()
    const now = Date.now()
    const lateMs = Math.max(0, now - entry.dueMs)
    const missed = lateMs > 5000 || entry.missed === true
    entry.missed = missed
    const sessionId = entry.sessionId
    const parentSession = entry.parentSession
    const note = entry.note
    const scheduledIso = iso(entry.dueMs)
    const currentIso = iso(now)
    const lateText = lateMs >= 60000 ? Math.round(lateMs / 60000) + ' 分钟' : Math.round(lateMs / 1000) + ' 秒'
    const text = missed
      ? '\u23F0 定时提醒补触发（未及时触发）\n\n原定时间：' + scheduledIso + '\n当前时间：' + currentIso + '\n状态：未及时触发，已延迟约 ' + lateText + '，现在补触发\n\n提醒内容：' + note + '\n\n请现在自主去查看/处理这件事，完成后向用户汇报结果。'
      : '\u23F0 定时提醒触发（这是你之前给自己安排的检查）：\n\n' + note + '\n\n现在请自主去查看/处理这件事，完成后向用户汇报结果。'
    const summary = '\u23F0 ' + (missed ? '补触发：' : '') + (note.length > 100 ? note.slice(0, 99) + '\u2026' : note)
    const message = {
      id: makeId(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'timer-scheduler', form: 'notice', summary },
    }
    function succeed() {
      if (entry.retryTimer) { entry.retryTimer(); entry.retryTimer = null }
      entry.cancel = null
      entry.delivering = false
      if (pending.delete(entry.id)) persist()
      console.log(`timer-scheduler: fired reminder ${JSON.stringify(summary)}`)
    }
    function fail(err, kind) {
      entry.delivering = false
      entry.deliveryUncertain = false
      entry.missed = true
      entry.lastError = String((err && err.message) || err)
      const network = isNetworkError(err)
      if (network) {
        entry.networkBlocked = true
        entry.needsManualRetry = true
        persist()
        console.warn(`timer-scheduler: network failure (${kind}) for ${entry.id}; no auto retry, manual retry required: ${entry.lastError}`)
        return
      }
      entry.networkBlocked = false
      const immediateRetries = Number(entry.immediateRetries || 0)
      if (immediateRetries < 1) {
        entry.immediateRetries = immediateRetries + 1
        entry.needsManualRetry = false
        persist()
        console.warn(`timer-scheduler: non-network failure (${kind}) for ${entry.id}; retrying immediately: ${entry.lastError}`)
        if (entry.retryTimer) { entry.retryTimer(); entry.retryTimer = null }
        entry.retryTimer = ctx.timeout(() => {
          entry.retryTimer = null
          fire(entry)
        }, 0)
        return
      }
      entry.needsManualRetry = true
      persist()
      console.warn(`timer-scheduler: non-network failure persisted (${kind}) for ${entry.id}; manual retry required: ${entry.lastError}`)
    }
    const deliver = (agent) => {
      try {
        agent.followup(message)
        succeed()
        return true
      } catch (err) {
        fail(err, 'followup')
        return false
      }
    }
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) {
      // A live agent already runs the composition it started with, so a plain
      // followup preserves its tools. (Live includes a live subagent child.)
      deliver(live)
      return
    }
    // Nothing has been injected at this point, so parking is never "delivery uncertain".
    const park = (reason) => {
      entry.delivering = false
      entry.deliveryUncertain = false
      entry.missed = true
      entry.needsManualRetry = true
      entry.lastError = reason
      persist()
      console.warn(`timer-scheduler: reminder ${entry.id} parked for manual retry: ${reason}`)
    }
    /** Live-preferred durable header: it names the session's preset and its lineage. */
    const readHeader = async () => {
      const attached = ctx.get('sessions')?.get?.(sessionId)
      if (attached?.header !== undefined) return attached.header
      const query = ctx.get('sessionQuery')
      if (typeof query?.observeSession !== 'function') return undefined
      const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
      return observation?.header
    }
    void (async () => {
      const header = await readHeader()
      if (header?.origin === 'subagent') {
        // Session-backed subagent children are owned by the subagent continuation
        // seam: it alone cold-resumes the SAME child with the persona/toolFilter
        // recorded in its descriptor, and keeps the parent's ownership of it.
        // Resuming one as a root breaks later parent→child delivery with
        // "already owned by an active write handle".
        const subagents = ctx.get('subagents')
        const parentId = header.parentSession
        const liveParent = typeof parentId === 'string' && parentId.length > 0 ? ctx.agents.get(parentId) : undefined
        if (typeof subagents?.sendMessage === 'function' && liveParent !== undefined) {
          await subagents.sendMessage(liveParent, sessionId, [{ type: 'text', text }], { signal: new AbortController().signal })
          succeed()
          return
        }
        park(`子代理会话 ${sessionId} 未活动，且其直接父会话 ${parentId ?? '(未知)'} 不在线；按约定不会把提醒转投给父会话或分支会话`)
        logDeliveryError('subagent-parent-offline', sessionId, parentId ?? parentSession, new Error('continuable child not live and its direct parent is not live'))
        return
      }
      // Ordinary session, forked/branched ones included. Mount the preset it was
      // composed from: resuming without a preset composes NO tools at all, which
      // is how an earlier version produced `unknown tool "bash"` after a wake.
      // Fork lineage (header.parentSession) is history, never a delivery target.
      const presets = ctx.get('agentPresets')
      let setup
      let presetId
      if (typeof presets?.mount === 'function') {
        const resolved = await presets.resolve(header?.agentPreset)
        presetId = resolved.id
        setup = async (agentCtx) => { await presets.mount(agentCtx, resolved.id) }
      }
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      const resumeAgentOptions = selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : undefined
      let handle = resumed.get(sessionId)
      if (handle !== undefined && ctx.agents.get(sessionId) !== handle.agent) {
        // Kept from an earlier wake but closed or replaced since: drop the stale
        // handle instead of injecting into a dead agent.
        resumed.delete(sessionId)
        void handle.dispose().catch(() => {})
        handle = undefined
      }
      if (handle === undefined) {
        handle = await withTimeout(ctx.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeAgentOptions ? { agentOptions: resumeAgentOptions } : {}),
          ...(setup !== undefined ? { setup } : {}),
        }), RESUME_TIMEOUT_MS, `cold resume of ${sessionId}`)
        resumed.set(sessionId, handle)
        entry.resumeRetries = 0
        console.log(`timer-scheduler: cold-resumed session ${sessionId} for reminder${presetId !== undefined ? ` (preset ${presetId})` : ''}`)
      }
      deliver(handle.agent)
    })().catch((err) => {
      const detail = String((err && err.message) || err)
      const resumeRetries = Number(entry.resumeRetries || 0)
      if (TRANSIENT_RESUME.test(detail) && resumeRetries < RESUME_RETRY_DELAYS.length) {
        entry.resumeRetries = resumeRetries + 1
        entry.delivering = false
        entry.deliveryUncertain = false
        entry.missed = true
        entry.needsManualRetry = false
        entry.lastError = detail
        persist()
        const delay = RESUME_RETRY_DELAYS[resumeRetries]
        console.warn(`timer-scheduler: transient cold-resume failure for ${sessionId} (${detail}); retrying in ${Math.round(delay / 1000)}s (${entry.resumeRetries}/${RESUME_RETRY_DELAYS.length})`)
        if (entry.retryTimer) { entry.retryTimer(); entry.retryTimer = null }
        entry.retryTimer = ctx.timeout(() => {
          entry.retryTimer = null
          fire(entry)
        }, delay)
        return
      }
      const errCode = String((err && (err.code || (err.cause && err.cause.code))) || '')
      if (/agent-preset\//.test(errCode) || /agent-presets: preset .* not found|failed to mount/.test(detail)) {
        // The session's own preset is gone or unusable: no auto-retry can fix
        // that, and resuming under a different preset would hand the session a
        // composition it never had. Park it and tell the user which preset.
        park(`会话 ${sessionId} 的原预设不可用：${detail}`)
        logDeliveryError('agent-preset-unavailable', sessionId, entry.parentSession, err)
        return
      }
      logDeliveryError('cold-resume-failed', sessionId, entry.parentSession, err)
      fail(err, 'cold-resume')
    })
  }

  ctx.effect(() => {
    for (const [sessionId, handle] of resumed) {
      void handle.dispose().catch(() => {})
      resumed.delete(sessionId)
    }
  }, 'timer-scheduler-ui: cold-resumed handles')

  function scheduleRetry(entry) {
    if (entry.retryTimer) return
    if (entry.cancel) { entry.cancel(); entry.cancel = null }
    const attempts = Number(entry.attempts || 0)
    const delay = Math.min(5 * 60 * 1000, Math.max(10 * 1000, 10 * 1000 * Math.pow(2, Math.max(0, attempts - 1))))
    entry.retryTimer = ctx.timeout(() => {
      entry.retryTimer = null
      fire(entry)
    }, delay)
    console.warn(`timer-scheduler: will retry reminder ${entry.id} in ${Math.round(delay / 1000)}s`)
  }

  function arm(entry) {
    if (entry.deliveryUncertain || entry.networkBlocked || entry.needsManualRetry) return
    function tick() {
      if (entry.retryTimer) { entry.retryTimer(); entry.retryTimer = null }
      if (entry.deliveryUncertain || entry.networkBlocked || entry.needsManualRetry) return
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

  function schedule(note, dueMs, sessionId, subject, parentSession) {
    // The same note at the same minute from the same session is the same intent:
    // reuse the pending entry instead of queuing a second wake for it. (An agent
    // asked twice used to leave two identical reminders that both fired.)
    for (const existing of pending.values()) {
      if (existing.sessionId !== sessionId || existing.note !== note) continue
      if (Math.abs(existing.dueMs - dueMs) <= 60_000) return { entry: existing, reused: true }
    }
    const entry = { id: makeId(), note, dueMs, sessionId, subject: subject || undefined, parentSession: parentSession || undefined, cancel: null, retryTimer: null, delivering: false, missed: false, attempts: 0, lastAttemptAt: null, deliveryUncertain: false, networkBlocked: false, needsManualRetry: false, immediateRetries: 0, resumeRetries: 0, lastError: null }
    pending.set(entry.id, entry)
    persist()
    arm(entry)
    return { entry, reused: false }
  }

  function cancelEntry(id) {
    const entry = pending.get(id)
    if (entry === undefined) return false
    if (typeof entry.cancel === 'function') entry.cancel()
    if (typeof entry.retryTimer === 'function') entry.retryTimer()
    pending.delete(id)
    persist()
    return true
  }

  // Auto-cancel fallback reminders when the referenced background subagent
  // settles and its completion notice enters the parent's live inbox. This
  // covers both new `subject`-tagged reminders and older notes that embed the
  // child id in the reminder text.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const source = message?.source
    const text = String((message?.content ?? []).map((c) => c && typeof c === 'object' && typeof c.text === 'string' ? c.text : '').join(' '))
    let targetId = ''
    let targetKind = ''
    if (source?.kind === 'subagent-settled') {
      targetKind = 'subagent'
      targetId = typeof source.senderSessionId === 'string' ? source.senderSessionId : ''
      if (targetId === '') {
        const m = /Background subagent ([0-9a-f-]+) finished/.exec(text)
        targetId = m ? m[1] : ''
      }
    } else if (source?.plugin === 'tool-jobs') {
      targetKind = 'job'
      const m = /background job (\S+)/.exec(text)
      targetId = m ? m[1] : ''
    }
    if (targetId === '') return
    const toCancel = []
    for (const entry of pending.values()) {
      if (entry.sessionId !== agent.id) continue
      if (entry.subject === targetId) {
        toCancel.push(entry.id)
      } else if (!entry.subject && entry.note && entry.note.includes(targetId)) {
        toCancel.push(entry.id)
      }
    }
    if (toCancel.length > 0) {
      console.log(`timer-scheduler: ${targetKind} ${targetId} settled; canceling ${toCancel.length} fallback reminder(s) for ${agent.id}`)
      for (const id of toCancel) cancelEntry(id)
    }
  })

  // Auto-cancel reminders tied to a mission task when that task settles
  // (accepted or rejected). This prevents old "check task X" reminders from
  // firing long after the task has progressed past the checkpoint.
  function noteMentionsTask(note, taskId) {
    if (typeof note !== 'string' || note.length === 0) return false
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(^|[^A-Za-z0-9-])${escaped}([^A-Za-z0-9-]|$)`)
    return re.test(note)
  }

  ctx.on('mission/task-settled', ({ taskId, sessionId }) => {
    if (typeof taskId !== 'string' || taskId.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) return
    const toCancel = []
    for (const entry of pending.values()) {
      if (entry.sessionId !== sessionId) continue
      const matchesTask = entry.subject === taskId || noteMentionsTask(entry.note, taskId)
      if (!matchesTask) continue
      toCancel.push(entry.id)
    }
    if (toCancel.length > 0) {
      console.log(`timer-scheduler: mission task ${taskId} settled; canceling ${toCancel.length} reminder(s) for ${sessionId}`)
      for (const id of toCancel) cancelEntry(id)
    }
  })

  // Re-arm persisted reminders on startup. Overdue reminders are kept and
  // armed too: they fire immediately after restart instead of being dropped.
  for (const r of loadReminders()) {
    const wasDelivering = Boolean(r.delivering)
    const entry = { id: r.id, note: r.note, dueMs: r.dueMs, sessionId: r.sessionId, subject: typeof r.subject === 'string' ? r.subject : undefined, parentSession: typeof r.parentSession === 'string' ? r.parentSession : undefined, cancel: null, retryTimer: null, delivering: false, missed: Boolean(r.missed) || wasDelivering, attempts: Number(r.attempts || 0), lastAttemptAt: r.lastAttemptAt || null, deliveryUncertain: wasDelivering || Boolean(r.deliveryUncertain), networkBlocked: Boolean(r.networkBlocked), needsManualRetry: Boolean(r.needsManualRetry), immediateRetries: Number(r.immediateRetries || 0), resumeRetries: Number(r.resumeRetries || 0), lastError: r.lastError || null }
    pending.set(entry.id, entry)
    if (entry.deliveryUncertain || entry.networkBlocked || entry.needsManualRetry) {
      console.warn(`timer-scheduler: reminder ${entry.id} requires manual retry (${entry.deliveryUncertain ? 'delivery-uncertain' : entry.networkBlocked ? 'network-blocked' : 'previous-failure'}); not auto-injecting.`)
      persist()
    } else {
      arm(entry)
    }
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

  // ── model tools (HOST-plane: visible to every agent, any preset) ──────────

  ctx.tools.register({
    name: 'schedule_reminder',
    description: 'Schedule a one-shot timer that will wake YOU (the agent) at a future time so you can autonomously check on a long-running background job, a remote task, or anything that needs attention later, without the user having to wake you. Use delay_seconds for a relative wait, or at for an absolute clock time. When it fires you receive a new turn carrying the note and should act on it and report back.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'What to check or do when the timer fires. Be specific (include the job id, URL, or file) so future-you knows exactly what to inspect and report.' },
        delay_seconds: { type: 'number', description: 'Relative delay in seconds from now (300 = 5 min, 3600 = 1 hour, 7200 = 2 hours). Use EITHER this OR at.' },
        at: { type: 'string', description: 'Absolute time: ISO 8601 datetime ("2026-08-15T14:30:00") or 24h clock "HH:MM[:SS]" (today; if already past, tomorrow). Use EITHER this OR delay_seconds.' },
        subject: { type: 'string', description: 'Optional tag for automatic cancellation: pass the subagent id (or job id) this reminder is a fallback for. When that background subagent settles and its completion notice is delivered, the plugin cancels matching pending reminders automatically.' },
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
      const header = agent.session?.header
      const parentSession = header?.parentSession
      const { entry, reused } = schedule(String(args.note), dueMs, agent.id, typeof args.subject === 'string' ? args.subject : undefined, parentSession)
      const head = reused ? `复用已存在的定时提醒 ${entry.id}（同会话同内容同时间，未重复排队）` : `已设定时提醒 ${entry.id}`
      return `${head}\n到点: ${iso(entry.dueMs)}\n约 ${Math.round((entry.dueMs - Date.now()) / 1000)}s 后触发${entry.subject ? `\n关联: ${entry.subject}` : ''}`
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
        const state = e.deliveryUncertain ? '投递状态不确定，未重复注入（可用 retry_reminder 手动重试）' : e.networkBlocked ? '网络原因未发送，等待人工重试' : e.needsManualRetry ? '未发送，等待人工重试' : e.missed ? '未及时触发，等待重试' : (Date.now() >= e.dueMs ? '已到点，等待触发' : `约 ${remain}s`)
        // A parked reminder names WHY it is parked: a missing preset, an offline
        // subagent parent, or an exhausted retry all need different user action.
        const why = e.needsManualRetry && typeof e.lastError === 'string' && e.lastError.length > 0 ? `\n  原因: ${e.lastError}` : ''
        items.push(`- ${e.id}${e.subject ? ` [${e.subject}]` : ''} ${state} 到点 ${iso(e.dueMs)}${e.attempts ? ` attempts=${e.attempts}` : ''}\n  ${e.note}${why}`)
      }
      return items.length === 0 ? '暂无待触发的定时提醒' : `待触发的定时提醒（${items.length} 条）:\n${items.join('\n')}`
    },
  })

  ctx.tools.register({
    name: 'retry_reminder',
    description: 'Force a missed or delivery-uncertain reminder to fire again. Use only after confirming the earlier attempt did not already reach the session; this may inject the reminder a second time.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The reminder id to retry.' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const entry = pending.get(args.id)
      if (entry === undefined) return `未找到提醒 ${args.id}`
      entry.deliveryUncertain = false
      entry.networkBlocked = false
      entry.needsManualRetry = false
      entry.immediateRetries = Number(entry.immediateRetries || 0)
      entry.delivering = false
      // Only a reminder that is actually past due is "late"; firing a future one
      // by hand is an early trigger, not a missed one.
      if (Date.now() >= entry.dueMs) entry.missed = true
      fire(entry)
      return `已触发提醒重试 ${entry.id}（如果之前已注入，可能产生重复上下文）`
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

  // ── browser data route ────────────────────────────────────────────────────

  ctx.inject(['webServer'], (httpCtx) => {
    /** Own the whole response for one JSON payload; the route never streams. */
    function sendJson(res, status, payload) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    /**
     * Push one queued reminder out by hand. `retry` clears every parked/failed
     * flag and fires now; `cancel` drops it. This is the same state change the
     * model tools make, exposed so the header menu can act without an agent —
     * otherwise a parked entry is visible but unpushable from the browser.
     */
    function actOnReminder(action, id, sessionId, res) {
      const entry = pending.get(id)
      if (entry === undefined) { sendJson(res, 404, { ok: false, error: 'not-found', id }); return }
      if (sessionId !== '' && entry.sessionId !== sessionId) { sendJson(res, 403, { ok: false, error: 'session-mismatch', id }); return }
      if (action === 'cancel') {
        cancelEntry(id)
        sendJson(res, 200, { ok: true, action: 'cancel', id })
        return
      }
      // 'retry' also covers 'fire now': the user is explicitly pushing this entry.
      entry.deliveryUncertain = false
      entry.networkBlocked = false
      entry.needsManualRetry = false
      entry.delivering = false
      entry.immediateRetries = 0
      entry.resumeRetries = 0
      // Firing a not-yet-due entry by hand is an early trigger, not a late one:
      // keep the plain "triggered" wording instead of "missed / delayed 0s".
      if (Date.now() >= entry.dueMs) entry.missed = true
      if (typeof entry.cancel === 'function') { entry.cancel(); entry.cancel = null }
      if (typeof entry.retryTimer === 'function') { entry.retryTimer(); entry.retryTimer = null }
      fire(entry)
      sendJson(res, 200, { ok: true, action: 'retry', id })
    }
    const dispose = httpCtx.webServer.register({
      kind: 'exact',
      path: '/api/timer-reminders',
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if ((req.method ?? 'GET').toUpperCase() === 'POST') {
            actOnReminder(url.searchParams.get('action') ?? '', url.searchParams.get('id') ?? '', sessionId, res)
            return
          }
          const reminders = sessionId === ''
            ? []
            : [...pending.values()]
              .filter((e) => e.sessionId === sessionId)
              .map((e) => ({ id: e.id, note: e.note, dueMs: e.dueMs, missed: Boolean(e.missed), attempts: Number(e.attempts || 0), lastAttemptAt: e.lastAttemptAt || null, delivering: Boolean(e.delivering), deliveryUncertain: Boolean(e.deliveryUncertain), networkBlocked: Boolean(e.networkBlocked), needsManualRetry: Boolean(e.needsManualRetry), lastError: e.lastError || null }))
          sendJson(res, 200, { reminders })
        } catch (err) {
          sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    })
    httpCtx.effect(() => dispose, 'timer-scheduler-ui: reminders route')
  })
}
