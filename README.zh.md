# dsh-timer-scheduler-ui

**语言：** [English](README.md) · [简体中文](README.zh.md)

DeepSeek Harness（DSH）插件：给 agent 一个**自主定时器**——让它在未来的某个时间点自动醒来，去检查后台任务 / 远程任务 / 任何需要「过一会儿再看一眼」的事，无需人类手动唤起；同时在 Web 界面**右下角**挂一个提醒倒计时面板。

## 功能

- **`schedule_reminder`**：安排一个一次性提醒，支持相对时间（`delay_seconds`）或绝对时间（ISO 8601 / `HH:MM[:SS]`）。
- **`list_reminders`**：查看当前待触发的提醒。
- **`cancel_reminder`**：按 id 取消提醒。
- **自动唤醒**：到点后通过 `agent.followup()` 把一条 `user` 消息投进该 agent 的 inbox，agent 以一个新轮次被唤醒并自主处理、汇报，**全程不需要人类唤起**。
- **持久化**：待触发提醒序列化到 `$DSH_HOME/timer-reminders.json`，进程重启后重新 arm，提醒不丢。
- **右下角面板**（client 半面）：显示每条提醒的备注 + 实时倒计时，主题跟随 `--dsw-alias-*`，无提醒时自动隐藏、不挡发送按钮。

## 结构

一个包、两个半面，照 `dsh.client` + `dsh.bundle.patch` 的标准插件形态组织。**全部是 host 平面**：把这个 bundle 组合进 web profile 的宿主组合后，模型工具对**任何 preset 的每个 agent 都可见**，路由则服务浏览器面板。

| 文件 | 半面 | 作用 |
| --- | --- | --- |
| `lib/index.js` | Host | 三个模型工具（`schedule_reminder` / `list_reminders` / `cancel_reminder`）+ 自动唤醒 + 落盘持久化 + `GET /api/timer-reminders` |
| `lib/client.js` | Client | `shell.overlay` 右下角面板，每秒 `fetch` 刷新倒计时 |
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

1. 把本目录放进 web profile 的工作区，并在 web profile 的 `package.json` 里挂载依赖与 bundle：

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

2. 安装并重启：

   ```sh
   cd <web-profile>
   pnpm install
   # 重启 dsh web（Host 半面运行在服务进程里），然后强制刷新页面
   ```

3. 验证：

   ```sh
   curl 'http://127.0.0.1:<port>/api/timer-reminders?sessionId=x'   # → {"reminders":[]}
   curl 'http://127.0.0.1:<port>/plugins/dsh-timer-scheduler-ui/client.js'   # → 200 JS
   ```

发布到 npm 后可用 `dsh plugin --profile web add dsh-timer-scheduler-ui`。

## 用法

在 agent 会话里直接说：

- 「**30 分钟后提醒我看看那个后台任务跑完没**」→ `schedule_reminder(delay_seconds=1800, note=…)`
- 「**下午 3 点看一眼部署结果**」→ `schedule_reminder(at="15:00", note=…)`
- 用 `list_reminders` / `cancel_reminder` 管理已有提醒。

右下角面板：有提醒时显示倒计时，到点自动消失；没提醒时隐藏。

## 工作机制

1. agent 调 `schedule_reminder`，host 插件用 Cordis `timer` 排一个一次性定时器，并把 `{id, note, dueMs, sessionId}` 写入 `~/.dsh/timer-reminders.json`。
2. 到点时，host 插件通过 `agents.get(sessionId)` 找到对应 agent，构造一条 `source.kind = 'plugin'` 的 user 消息并 `agent.followup()` 投递，唤醒 driver。
3. 本包（client 半面）每秒 `fetch` 一次 `/api/timer-reminders?sessionId=…`，从同一份文件读出本会话的提醒并渲染倒计时。

## 已知限制

- 提醒到点时，**对应的会话必须是 live 的**（进程运行中、会话已打开）。会话处于冷状态（重启后未重新打开）时，提醒会被跳过并打一条警告日志——冷恢复（cold-resume）不在当前范围内。
- 超过约 24.8 天的定时用分段续期实现，理论支持；但提醒是「进程内 timer + 磁盘快照」的混合，进程长时间不重启即可正常触发。

## License

[MIT](LICENSE)
