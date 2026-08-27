# dsh-timer-scheduler-ui

**Languages:** [English](README.md) · [简体中文](README.zh.md)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin: an **agent self-scheduler** that wakes the agent at a future time to autonomously check on background jobs, remote tasks, or anything that needs a "come back later" look — without a human having to prompt it — plus a **header reminder menu** in the web UI.

## Features

- **`schedule_reminder`** — schedule a one-shot reminder, relative (`delay_seconds`) or absolute (`at`: ISO 8601 / `HH:MM[:SS]`).
- **`list_reminders`** — list pending reminders.
- **`cancel_reminder`** — cancel a reminder by id.
- **Auto-wake** — on fire, the agent is woken through `agent.followup()` with a new turn; it acts and reports on its own, no human wake-up needed.
- **Persistence** — pending reminders are serialized to `$DSH_HOME/timer-reminders.json` and re-armed on restart.
- **Header reminder menu** (client half) — per-reminder note + live countdown, theme-aware via `--dsw-alias-*` tokens, hidden when empty, never covering the send button.

## Structure

One package, two halves, in the standard `dsh.client` + `dsh.bundle.patch` shape. Everything is **host-plane**: composing this bundle into the web profile's host composition makes the model tools available to **every agent regardless of preset**, and the route serves the browser panel.

| File | Half | Role |
| --- | --- | --- |
| `lib/index.js` | Host | The three model tools (`schedule_reminder` / `list_reminders` / `cancel_reminder`), auto-wake, disk persistence, and `GET /api/timer-reminders` |
| `lib/client.js` | Client | `conversation.session.header.actions` compact dropdown, polling every second |
| `cordis.patch.yml` | bundle | Inserts the Host half into the web profile's host composition |
| `package.json` | — | `dsh.client` (browser bundle) + `dsh.bundle.patch` (host row) |

**Preset adaptation:** the `anchored-standard` preset keeps these tools resident for its agents via its `residentTools` option; every other preset works without any configuration.

## Installation

Not published to npm yet. Install from source:

> **Host-plane tools:** once this bundle is composed, every agent on any preset can call `schedule_reminder` / `list_reminders` / `cancel_reminder`. If a preset uses an aggressive tool-bootstrap filter (like `anchored-standard`), keep the three tool names resident so its agents still see them:
>
> ```yaml
> # inside the tool-bootstrap row's config
> residentTools: [schedule_reminder, list_reminders, cancel_reminder]
> ```

1. Place this directory in the web profile workspace and mount it as a dependency + bundle in the profile's `package.json`:

   ```json
   {
     "dependencies": {
       "dsh-timer-scheduler-ui": "file:./packages/dsh-timer-scheduler-ui"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-timer-scheduler-ui"
         ]
       }
     }
   }
   ```

2. Install and restart:

   ```sh
   cd <web-profile>
   pnpm install
   # restart dsh web (the Host half runs in the server process), then hard-refresh
   ```

3. Verify:

   ```sh
   curl 'http://127.0.0.1:<port>/api/timer-reminders?sessionId=x'   # → {"reminders":[]}
   curl 'http://127.0.0.1:<port>/plugins/dsh-timer-scheduler-ui/client.js'   # → 200 JS
   ```

Once published to npm: `dsh plugin --profile web add dsh-timer-scheduler-ui`.

## Usage

In an agent session, just say:

- "Remind me in 30 minutes to check that background job" → `schedule_reminder(delay_seconds=1800, note=…)`
- "Check the deployment at 3pm" → `schedule_reminder(at="15:00", note=…)`
- Manage with `list_reminders` / `cancel_reminder`.

The header reminder menu shows the countdown while reminders are pending and hides when empty.

## How it works

1. The agent calls `schedule_reminder`; the host plugin arms a one-shot Cordis `timer` and writes `{id, note, dueMs, sessionId}` to `~/.dsh/timer-reminders.json`.
2. On fire, the host plugin resolves the agent via `agents.get(sessionId)`. If it is not live, the plugin cold-resumes the persisted session through `ctx.agents.resume()`, then builds a `source.kind = 'plugin'` user message and delivers it through `agent.followup()` to wake the driver. This works for both regular sessions and continuable subagent sessions (as long as session persistence is configured and the session can be resumed).
3. This package's client half fetches `/api/timer-reminders?sessionId=…` every second and renders the countdown from that same file.

## Known limitations

- Cold resume requires session persistence to be configured and the owning session to be resumable. If resume fails, the reminder is logged and skipped rather than silently dropped. The cold-resumed AgentHandle is kept until the plugin is unloaded, so the woken session stays resident after the reminder; a future version may dispose it after the wake turn settles.
- Reminders that become due while the DSH process is down are re-armed on startup and fire immediately (instead of being skipped).
- Delays beyond ~24.8 days are chunked, so they work, but the mechanism is "in-process timer + disk snapshot"; the timer only needs the process to stay up to fire.

## License

[MIT](LICENSE)
