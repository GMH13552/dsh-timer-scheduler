# dsh-timer-scheduler-ui

**Languages:** [English](README.md) · [简体中文](README.zh.md)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin: an **agent self-scheduler** that wakes the agent at a future time to autonomously check on background jobs, remote tasks, or anything that needs a "come back later" look — without a human having to prompt it — plus a **header reminder menu** in the web UI.

## Features

- **`schedule_reminder`** — schedule a one-shot reminder, relative (`delay_seconds`) or absolute (`at`: ISO 8601 / `HH:MM[:SS]`).
- **Auto-cancel via `subject`** — pass a `subject` (background subagent id / shell background job id); when that subagent or background job settles and its completion notice enters the parent inbox, the plugin cancels matching reminders automatically.
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

1. Install it into a profile (this registers both the dependency and the
   bundle entry, so the Host half is composed):

   ```sh
   dsh plugin --profile web add /path/to/dsh-timer-scheduler
   ```

   Manual equivalent, if you prefer editing the profile yourself — the profile's
   `package.json` needs the package in **both** places:

   ```json
   {
     "dependencies": { "dsh-timer-scheduler-ui": "file:./packages/dsh-timer-scheduler-ui" },
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-timer-scheduler-ui"] } }
   }
   ```

2. Restart DSH (the Host half lives in the server process; a browser refresh is
   not enough), then hard-refresh the page.

3. Verify from a shell — the Host half must answer both the list and an action:

   ```sh
   curl 'http://127.0.0.1:<port>/api/timer-reminders?sessionId=x'                  # → {"reminders":[]}
   curl -X POST 'http://127.0.0.1:<port>/api/timer-reminders?action=retry&id=nope&sessionId=x'
   # → 404 {"ok":false,"error":"not-found","id":"nope"}   (an OLD host answers 200 with the reminder list here)
   ```

   Then open any session: the session-header menu shows the countdown, and each
   row has 补触发 / 取消.

## Standalone check (no DSH session needed)

```sh
node test/delivery.mjs          # 8 cases: same-session delivery, resume w/ preset, queue actions, dedupe
node --check lib/index.js lib/client.js
```

A full standalone proof installs into a disposable profile and boots it; the
exact commands and their recorded output are in `PROFILE_EVIDENCE.md`.

## Usage

In an agent session, just say:

- "Remind me in 30 minutes to check that background job" → `schedule_reminder(delay_seconds=1800, note=…, subject=<subagentId>)`
- "Check the deployment at 3pm" → `schedule_reminder(at="15:00", note=…)`
- Manage with `list_reminders` / `cancel_reminder`.

The header reminder menu shows the countdown while reminders are pending and hides when empty.

## How it works

1. The agent calls `schedule_reminder`; the host plugin arms a one-shot Cordis `timer` and writes `{id, note, dueMs, sessionId, subject?}` to `~/.dsh/timer-reminders.json`.
2. On fire, the host plugin wakes **the same session that armed the reminder** — never a relaunched stand-in and never a pre-branch/archived parent:
   - **live session** → `agent.followup()` (a live agent already carries its own tools);
   - **cold ordinary session** (forked/branched ones included) → `ctx.agents.resume()` with the session's **own persisted preset** mounted in the factory `setup` (`header.agentPreset` → `agentPresets.mount`), so the resumed agent gets the tool registry and prompt sections it was created with. Resuming without that `setup` composes **no tools at all** — the historical `unknown tool "bash"` failure after a wake;
   - **cold session-backed subagent child** → `ctx.subagents.sendMessage()` through its exact live direct parent, so the continuation seam cold-resumes the same child with the `persona`/`toolFilter` recorded in its durable `subagent/descriptor` and keeps the parent's ownership of it. Resuming such a child as a root instead breaks later parent→child delivery with *"already owned by an active write handle"*.
   A message is then built with `source.kind = 'plugin'` and delivered to that agent to wake its driver.
   `header.parentSession` is durable fork lineage (or a child's direct parent) — installation history, never a delivery target.
3. If a reminder carries a `subject` and a matching background subagent completion notice (`source.kind = 'subagent-settled'`) or shell background job completion notice (`source.plugin = 'tool-jobs'`) enters the parent session's inbox, the host plugin cancels the reminder automatically.
4. This package's client half fetches `/api/timer-reminders?sessionId=…` every second and renders the countdown in the session-header menu.
5. The menu is also the manual control surface: each row has **补触发** (fire now, in the SAME session) and **取消** buttons, backed by `POST /api/timer-reminders?action=retry|cancel&id=…&sessionId=…`. Without them a parked or overdue entry was visible but unpushable from the browser — only an agent could call `retry_reminder`.
6. Scheduling the same note for the same session within the same minute reuses the pending entry instead of stacking a second identical reminder (`已设定时提醒` vs `复用已存在的定时提醒`), so an agent asked twice cannot leave two wakes that both fire.

## Known limitations

- Cold resume requires session persistence to be configured and the owning session to be resumable. Resuming a session mounts the preset named by its durable `agentPreset`; if that preset was deleted or will not mount, the reminder is **parked for manual retry** (`list_reminders` shows the reason) instead of being resumed under a different composition.
- Transient resume failures (agent-loop not loaded yet at startup, session still owned by an in-flight write handle) are retried with bounded backoff (2s/5s/15s) — never by re-routing the reminder to another session.
- A cold **subagent child** can only be resumed through its live direct parent. If that parent is offline the reminder is parked for manual retry; the plugin will not wake an archived parent session on your behalf.
- Cold resume is bounded at 90s: a resume that never settles retries with backoff instead of leaving the entry `delivering` forever (which made it invisible to re-arming and unpushable).
- The cold-resumed AgentHandle is kept until the plugin is unloaded, so the woken session stays resident after the reminder; a future version may dispose it after the wake turn settles. A handle whose session was closed or replaced in the meantime is dropped and resumed again.
- Reminders that become due while the DSH process is down are re-armed on startup and fire immediately (instead of being skipped).
- Delays beyond ~24.8 days are chunked, so they work, but the mechanism is "in-process timer + disk snapshot"; the timer only needs the process to stay up to fire.

## Installing into a profile

`node scripts/sync-profile.mjs [profile-dir]` copies `lib/` into both installed copies (`packages/…` and `node_modules/…`) **and into the root aliases** `index.js` / `client.js`.

That last part is not cosmetic. The host loader resolves the bundle name to the package directory and can prefer a root `index.js` when one exists, so a stale root alias makes the profile keep running old host code after a restart while `lib/` looks current — the visible symptom is a menu action that returns HTTP 200 and does nothing, because the old handler ignores the request method. Always sync through the script (or copy both layouts) after editing `lib/`.

## Tests

`node test/delivery.mjs` runs the delivery-contract regression suite against a fake host: live session, cold forked session with preset restoration, deleted preset, transient factory-missing retry, cold subagent child with an offline parent, and cold subagent child with a live parent. It asserts that a reminder never reroutes to a parent/branch session.

## License

[MIT](LICENSE)
