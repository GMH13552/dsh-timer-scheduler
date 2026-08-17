# dsh-timer-scheduler-ui

**Languages:** [English](README.md) · [简体中文](README.zh.md)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin: an **agent self-scheduler** that wakes the agent at a future time to autonomously check on background jobs, remote tasks, or anything that needs a "come back later" look — without a human having to prompt it — plus a **bottom-right reminder panel** in the web UI.

## Features

- **`schedule_reminder`** — schedule a one-shot reminder, relative (`delay_seconds`) or absolute (`at`: ISO 8601 / `HH:MM[:SS]`).
- **`list_reminders`** — list pending reminders.
- **`cancel_reminder`** — cancel a reminder by id.
- **Auto-wake** — on fire, the agent is woken through `agent.followup()` with a new turn; it acts and reports on its own, no human wake-up needed.
- **Persistence** — pending reminders are serialized to `$DSH_HOME/timer-reminders.json` and re-armed on restart.
- **Bottom-right panel** (client half) — per-reminder note + live countdown, theme-aware via `--dsw-alias-*` tokens, hidden when empty, never covering the send button.

## Structure

The full feature spans the two DSH planes; this repository ships **both halves**:

| File | Plane | Role |
| --- | --- | --- |
| `preset/timer-scheduler.mjs` | Agent preset | The three model tools (`schedule_reminder` / `list_reminders` / `cancel_reminder`), auto-wake, and disk persistence |
| `lib/index.js` | Web · Host | Registers `GET /api/timer-reminders`, filtered by `sessionId` |
| `lib/client.js` | Web · Client | `shell.overlay` bottom-right panel, polling every second |
| `cordis.patch.yml` | Web · bundle | Inserts the Host half into the web profile's host composition |
| `package.json` | — | `dsh.client` (browser bundle) + `dsh.bundle.patch` (host row) |

The agent-plane half is where the model-facing tools live — they must be composed into an agent preset for the model to see them. The web half provides the visual progress + data route. The two halves communicate through `$DSH_HOME/timer-reminders.json`.

## Installation

The feature needs both halves installed.

### 1. Agent plane — scheduling tools

Copy `preset/timer-scheduler.mjs` into your agent preset directory and add a row to its `agent.cordis.yml`:

```yaml
- id: timer-scheduler
  name: ./timer-scheduler.mjs
```

If your preset uses a tool-bootstrap filter (like the `anchored-standard` preset), keep the three tool names resident so the model can always see them:

```yaml
# inside the tool-bootstrap row's config
residentTools: [schedule_reminder, list_reminders, cancel_reminder]
```

Restart `dsh` — preset `.mjs` plugins are loaded at process start.

### 2. Web plane — reminder panel

Not published to npm yet. Install from source:

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

The bottom-right panel shows the countdown while reminders are pending and hides when empty.

## How it works

1. The agent calls `schedule_reminder`; the preset plugin arms a one-shot Cordis `timer` and writes `{id, note, dueMs, sessionId}` to `~/.dsh/timer-reminders.json`.
2. On fire, the preset plugin resolves the agent via `agents.get(sessionId)`, builds a `source.kind = 'plugin'` user message, and delivers it through `agent.followup()` to wake the driver.
3. This package's client half fetches `/api/timer-reminders?sessionId=…` every second and renders the countdown from that same file.

## Known limitations

- On fire, the owning **session must be live** (process running, session open). A cold session is skipped with a warning — cold-resume is out of scope for now.
- Delays beyond ~24.8 days are chunked, so they work, but the mechanism is "in-process timer + disk snapshot"; the timer only needs the process to stay up to fire.

## License

[MIT](LICENSE)
