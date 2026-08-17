/**
 * dsh-timer-scheduler-ui — host half: serves the pending reminder list to the
 * browser over one HTTP route. The reminders themselves are owned and persisted
 * by the agent-plane `timer-scheduler` preset plugin (`~/.dsh/timer-reminders.json`,
 * one record per pending reminder, keyed by session id). This route reads that
 * file and filters for the requesting session, so the browser panel only ever
 * sees its own session's reminders.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'timer-scheduler-ui'

function home() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  if (typeof process.env.HOME === 'string' && process.env.HOME.length > 0) return join(process.env.HOME, '.dsh')
  return process.cwd()
}

export function apply(ctx) {
  ctx.inject(['webServer'], (httpCtx) => {
    const dispose = httpCtx.webServer.register({
      kind: 'exact',
      path: '/api/timer-reminders',
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          let list = []
          try {
            const parsed = JSON.parse(readFileSync(join(home(), 'timer-reminders.json'), 'utf8'))
            if (Array.isArray(parsed)) list = parsed
          } catch {
            // Missing or malformed file → empty list.
          }
          const reminders = sessionId === ''
            ? []
            : list.filter((r) => r !== null && typeof r === 'object' && r.sessionId === sessionId)
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(JSON.stringify({ reminders }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: String((err && err.message) || err) }))
        }
      },
    })
    httpCtx.effect(() => dispose, 'timer-scheduler-ui: reminders route')
  })
}
