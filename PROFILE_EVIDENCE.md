# Disposable Profile Evidence: dsh-timer-scheduler-ui

Status: **verified end-to-end** on 2026-09-17 (DSH `0.1.5-rc.1`, pnpm 11.22.0) against a
clean export of this repository — no suite, no shared profile, no pre-existing state.

Everything below is recorded output, not a plan. Reproduce it with the same commands;
the only variable is the checkout path.

## 1. Self-checks (no DSH, no browser, no network)

```console
$ node --check lib/index.js lib/client.js
(no output = both halves parse)

$ node test/delivery.mjs
case: live session
  ok   delivered to the live agent
  ok   did NOT cold-resume a live session
case: cold forked session
  ok   resumed the same session id
  ok   passed a factory setup (preset mount)
  ok   mounted the session's OWN persisted preset
  ok   delivered the reminder after resume
  ok   passed the default model selection
  ok   never touched the fork-lineage parent session
case: deleted preset
  ok   did NOT resume under a different composition
  ok   parked for manual retry
  ok   named the unavailable preset
  ok   nothing was delivered
case: transient factory-missing failure
  ok   retried the SAME session after the failure
  ok   the retry carried the preset mount
  ok   delivered after the retry
  ok   never rerouted to another session
case: cold subagent child with offline parent
  ok   did NOT root-resume the child
  ok   did NOT deliver through the seam
  ok   parked for manual retry
  ok   explained which parent is offline
case: cold subagent child with live parent
  ok   delivered through ctx.subagents.sendMessage
  ok   sent from the exact live direct parent
  ok   targeted the same child id
  ok   did NOT root-resume the child
  ok   delivered a real reminder text
case: duplicate schedule is reused
  ok   first schedule created an entry
  ok   second schedule reused it
  ok   only one reminder is pending
case: menu retry / cancel actions
  ok   a queue-action route is registered
  ok   another session cannot act on it
  ok   an unknown id answers 404
  ok   retry is accepted
  ok   retry delivered to the SAME session right away
  ok   the delivered entry left the queue
  ok   cancel is accepted
  ok   cancelled entry is gone from the queue
  ok   cancel injected nothing

all delivery-contract cases passed

$ node test/client.mjs
  ok   bundle registers itself through the module loader
  ok   registration carries the plugin id
  ok   factory exports an inject list
  ok   inject list keeps slots/timer/sessions
  ok   factory exports apply()
  ok   registers one session-header slot
  ok   slot id/order are stable
  ok   styles are injected once
  ok   row renders exactly the two manual controls
  ok   fire button is labelled 补触发
  ok   fire button tooltip is exactly 立刻触发
  ok   cancel button is labelled 取消
  ok   both controls are type=button
  ok   both controls carry click handlers

all client-half cases passed
```

## 2. Install into a disposable profile (isolated `DSH_HOME`)

```console
$ export DSH_HOME=/tmp/dsh-evidence                 # never the real ~/.dsh
$ dsh --from-default-profile web --profile store-test --dump-config >/dev/null
$ dsh plugin --profile store-test add /path/to/dsh-timer-scheduler

dependencies:
+ dsh-timer-scheduler-ui link:/path/to/dsh-timer-scheduler
Done in 1.1s using pnpm v11.22.0

$ python3 -c "import json;d=json.load(open('profiles/store-test/package.json'));print(d['dependencies']);print(d['dsh']['profile']['bundles'])"
{'dsh-timer-scheduler-ui': 'link:/path/to/dsh-timer-scheduler'}
['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-timer-scheduler-ui']
```

Note: `dsh plugin … add` registers **both** the dependency and the bundle entry.
A manually edited profile needs both, or the Host half is never composed.

## 3. Composition

```console
$ dsh --profile store-test --dump-config | grep -A2 dsh-timer-scheduler-ui
# == dsh-timer-scheduler-ui
- id: timer-scheduler-ui
  name: dsh-timer-scheduler-ui
```

## 4. Real boot of that disposable profile

```console
$ dsh --profile store-test --port 3099 --no-open
dsh web: http://127.0.0.1:3099/?token=…

$ curl 'http://127.0.0.1:3099/api/timer-reminders?sessionId=x'
{"reminders":[]}                                    HTTP 200

$ curl -X POST 'http://127.0.0.1:3099/api/timer-reminders?action=retry&id=nope&sessionId=x'
{"ok":false,"error":"not-found","id":"nope"}        HTTP 404

$ kill <pid>                                         # port 3099 closed
```

The POST probe is the discriminating one: it proves the running Host half is
**this** version. An older Host answers `200 {"reminders":[...]}` there — it
ignores the request method and serves the list, which is exactly what makes a
menu button look "clicked but dead".

## 5. Uninstall / cleanup

```console
$ rm -rf /tmp/dsh-evidence
```

## 6. What is NOT covered here

- The browser rendering path is covered by `test/client.mjs` at the component
  level (bundle bootstrap → slot registration → rendered row); the live
  browser↔host wiring is only exercised in a real web session.
- `schedule_reminder` firing against a *cold* session needs session persistence
  and a real agent loop; `test/delivery.mjs` covers that logic with stubs.
