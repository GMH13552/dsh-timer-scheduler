# dsh-timer-scheduler-ui

**语言：** [English](README.md) · [简体中文](README.zh.md)

DeepSeek Harness（DSH）插件：给 agent 一个**自主定时器**——让它在未来的某个时间点自动醒来，去检查后台任务 / 远程任务 / 任何需要「过一会儿再看一眼」的事，无需人类手动唤起；同时在 Web 界面**顶部会话头**挂一个顶部会话头提醒入口。

## 功能

- **`schedule_reminder`**：安排一个一次性提醒，支持相对时间（`delay_seconds`）或绝对时间（ISO 8601 / `HH:MM[:SS]`）。
- **`subject` 自动取消**：可给提醒传一个 `subject`（后台子代理 id / shell background job id）；当对应后台子代理 or shell job settled、完成通知注入父会话 inbox 时，插件自动删除匹配提醒，避免过期提醒再唤醒。
- **`list_reminders`**：查看当前待触发的提醒。
- **`cancel_reminder`**：按 id 取消提醒。
- **自动唤醒**：到点后通过 `agent.followup()` 把一条 `user` 消息投进该 agent 的 inbox，agent 以一个新轮次被唤醒并自主处理、汇报，**全程不需要人类唤起**。
- **持久化**：待触发提醒序列化到 `$DSH_HOME/timer-reminders.json`，进程重启后重新 arm，提醒不丢。
- **顶部会话头提醒菜单**（client 半面）：显示每条提醒的备注 + 实时倒计时，主题跟随 `--dsw-alias-*`，无提醒时自动隐藏、不挡发送按钮。

## 结构

一个包、两个半面，照 `dsh.client` + `dsh.bundle.patch` 的标准插件形态组织。**全部是 host 平面**：把这个 bundle 组合进 web profile 的宿主组合后，模型工具对**任何 preset 的每个 agent 都可见**，路由则服务浏览器面板。

| 文件 | 半面 | 作用 |
| --- | --- | --- |
| `lib/index.js` | Host | 三个模型工具（`schedule_reminder` / `list_reminders` / `cancel_reminder`）+ 自动唤醒 + 落盘持久化 + `GET /api/timer-reminders` |
| `lib/client.js` | Client | `conversation.session.header.actions` 紧凑下拉菜单，每秒 `fetch` 刷新倒计时 |
| `cordis.patch.yml` | bundle | 把 Host 半面插入 web profile 的宿主组合 |
| `package.json` | — | `dsh.client`（浏览器 bundle 声明）+ `dsh.bundle.patch`（宿主行） |

**预设适配：** 已对 `anchored-standard` 预设做了适配（其工具门控的 `residentTools` 使这些工具常驻可见）；其余 preset 无需任何配置。

## 安装

本包尚未发布到 npm，按源码安装：

> **host 平面工具**：一旦本 bundle 被组合，任何 preset 的每个 agent 都能调 `schedule_reminder` / `list_reminders` / `cancel_reminder`。如果你的预设带激进的工具门控（比如 `anchored-standard` 的 tool-bootstrap），把这几个工具名加进常驻集，保证其 agent 仍能看到：
>
> ```yaml
> # 在 tool-bootstrap 那一行的 config 里
> residentTools: [schedule_reminder, list_reminders, cancel_reminder]
> ```

1. 装进某个 profile（这一条命令会同时注册依赖与 bundle，host 半才会被组合进去）：

   ```sh
   dsh plugin --profile web add /path/to/dsh-timer-scheduler
   ```

   想手改 profile 的话，`package.json` 里**两个地方都要有**：

   ```json
   {
     "dependencies": { "dsh-timer-scheduler-ui": "file:./packages/dsh-timer-scheduler-ui" },
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-timer-scheduler-ui"] } }
   }
   ```

2. 重启 DSH（host 半在服务进程里，只刷新浏览器不够），然后硬刷新页面。

3. 命令行验证——host 半必须同时答得上「列表」和「动作」：

   ```sh
   curl 'http://127.0.0.1:<port>/api/timer-reminders?sessionId=x'                  # → {"reminders":[]}
   curl -X POST 'http://127.0.0.1:<port>/api/timer-reminders?action=retry&id=nope&sessionId=x'
   # → 404 {"ok":false,"error":"not-found","id":"nope"}   （旧 host 在这里返回 200 + 提醒列表）
   ```

   然后打开任意会话：头部菜单显示倒计时，每行有 补触发 / 取消。

## 独立自检（不需要 DSH 会话）

```sh
node test/delivery.mjs          # 8 类用例：同会话投递、按预设冷恢复、队列动作、去重
node --check lib/index.js lib/client.js
```

完整的独立验证是「装进一次性 profile 并真正启动」：命令与实测输出见 `PROFILE_EVIDENCE.md`。

## 用法

在 agent 会话里直接说：

- 「**30 分钟后提醒我看看那个后台任务跑完没**」→ `schedule_reminder(delay_seconds=1800, note=…, subject=<subagentId>)`
- 「**下午 3 点看一眼部署结果**」→ `schedule_reminder(at="15:00", note=…)`
- 用 `list_reminders` / `cancel_reminder` 管理已有提醒。

顶部会话头提醒菜单：有提醒时显示倒计时，到点自动消失；没提醒时隐藏。

## 工作机制

1. agent 调 `schedule_reminder`，host 插件用 Cordis `timer` 排一个一次性定时器，并把 `{id, note, dueMs, sessionId, subject?}` 写入 `~/.dsh/timer-reminders.json`。
2. 到点时，host 插件唤醒的是**当初设定这条提醒的同一个会话**，不会换一个替身、也不会转投给分支之前/已归档的父会话：
   - **会话仍在内存** → `agent.followup()`（live agent 本来就带着自己的工具集）；
   - **普通会话已冷**（含 fork/分支出来的会话） → `ctx.agents.resume()`，并在 factory `setup` 里挂上该会话**自己持久化的预设**（`header.agentPreset` → `agentPresets.mount`），让恢复出来的 agent 拿回它创建时的工具注册表与提示词段落。不带这个 `setup` 去 resume 会**一个工具都不组合**——这正是历史上提醒醒来后 `unknown tool "bash"` 的原因；
   - **session-backed 子代理子会话已冷** → `ctx.subagents.sendMessage()`，通过它**仍在线的直接父会话**投递，由 continuation seam 按它 `subagent/descriptor` 里记录的 `persona`/`toolFilter` 冷恢复**同一个子会话**，并保持父会话对它的所有权。把这种子会话当 root 恢复，会让之后 parent→child 投递撞上 *"already owned by an active write handle"*。
   之后才构造一条 `source.kind = 'plugin'` 的 user 消息投递给该 agent 唤醒 driver。
   `header.parentSession` 是持久化的 fork 血缘（或子会话的直接父会话）——那是安装历史，永远不是投递目标。
3. 若提醒带有 `subject` 且对应后台子代理完成消息（`source.kind = 'subagent-settled'`）或 shell background job 完成消息（`source.plugin = 'tool-jobs'`）进入父会话 inbox，host 插件会自动取消该提醒。
4. 本包（client 半面）每秒 `fetch` 一次 `/api/timer-reminders?sessionId=…`，从同一份数据读出本会话的提醒并在会话头部渲染倒计时/状态。
5. 头部菜单同时是**人工控制面**：每行有 **补触发**（立刻触发，仍投给同一个会话）与 **取消** 按钮，走 `POST /api/timer-reminders?action=retry|cancel&id=…&sessionId=…`（跨会话请求返回 403）。没有它时，停在队列里的提醒「看得见但推不出去」——只有 agent 能调 `retry_reminder`。
6. 同一会话在同一分钟内重复排同一条 note 会**复用**已有提醒，而不是再堆一条（返回 `已设定时提醒` / `复用已存在的定时提醒` 两种措辞），避免「被问两次就留下两条都会触发的提醒」。

## 已知限制

- 冷恢复要求已配置 session persistence 且目标会话可恢复。恢复时挂载的是该会话 `agentPreset` 指定的预设；若该预设已被删除或挂载失败，提醒会**停在待人工重试**（`list_reminders` 会显示原因），而不是换一个预设组合把会话恢复起来。
- 瞬时恢复失败（启动时 agent-loop 尚未加载、会话仍被写句柄占用）按 2s/5s/15s 有界退避重试，**绝不**改用把提醒投给另一个会话的办法。
- 已冷的**子代理子会话**只能经它仍在线的直接父会话恢复；父会话不在线时提醒停在待人工重试，插件不会擅自唤醒归档的父会话。
- 冷恢复有 90s 上限：一直不返回的 `resume` 会按退避重试，而不是把条目永久卡在 `delivering`（那种状态下它既不参与重新 arm，也无法被人工推出）。
- 冷恢复出的 AgentHandle 会保持到插件卸载；若其会话中途被关闭或替换，该 handle 会被丢弃并重新恢复。
- 冷恢复出的 AgentHandle 会保持到插件卸载；因此被唤醒的会话在提醒后仍驻留内存。后续版本可考虑在唤醒 turn 结束后自动释放。
- DSH 进程停机期间到期的提醒，会在重启后重新 arm 并立即触发，而不是被跳过。
- 超过约 24.8 天的定时用分段续期实现，理论支持；但提醒是「进程内 timer + 磁盘快照」的混合，进程长时间不重启即可正常触发。

## 装进 profile

`node scripts/sync-profile.mjs [profile目录]` 会把 `lib/` 同步到 profile 里的两份安装副本（`packages/…` 与 `node_modules/…`），**同时写根别名 `index.js` / `client.js`**。

这一步不是多余的：host loader 解析 bundle 名时是按包目录找入口，**存在根 `index.js` 时会优先读它**。所以一旦根别名是旧快照，重启后 host 依旧跑旧代码，而 `lib/` 看起来是新的——症状就是菜单按钮返回 HTTP 200 但毫无反应（旧 handler 直接忽略请求方法，把 POST 当列表请求答了）。改完 `lib/` 一定用这个脚本同步（或两套布局都覆盖）。

## 测试

`node test/delivery.mjs` 用假 host 跑投递契约回归：live 会话、fork 冷会话按原预设恢复、预设被删、factory 未加载的瞬时重试、子代理子会话父离线、子代理子会话父在线。断言提醒**永不**改投父会话/分支会话。

## License

[MIT](LICENSE)
