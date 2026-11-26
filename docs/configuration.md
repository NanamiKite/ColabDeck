# 配置

所有设置都是 window 作用域。在 VS Code Settings 里搜 `colabdeck`，或直接改 `settings.json`。

## 探针

| Key | 默认 | 取值 | 说明 |
| --- | --- | --- | --- |
| `colabdeck.probe.sampleIntervalMs` | `5000` | 1000–60000 | 采样间隔。越小曲线越细，`metrics.jsonl` 增长越快。改动后重启采集。 |
| `colabdeck.probe.probeDir` | `/content/.colabdeck` | 绝对路径 | 探针在远端的目录，必须在 `/content` 下，不能含 `..`。改动后重启采集。 |

探针通过官方命令 `colab.openTerminal` 启动：它会开一个连到 runtime 的终端并发送启动命令。若已有终端名称精确匹配当前服务器，ColabDeck 会复用它；ColabDeck 不会隐藏或销毁终端，也不会接受任意新终端作为目标。

## Idle Guard

| Key | 默认 | 取值 | 说明 |
| --- | --- | --- | --- |
| `colabdeck.idleGuard.enabled` | `true` | boolean | 总开关。关闭后立即取消计时器。 |
| `colabdeck.idleGuard.gpuUtilizationThresholdPct` | `5` | 0–100 | GPU 利用率低于该值视为闲置。 |
| `colabdeck.idleGuard.idleDebounceMs` | `5000` | 1000–600000 | 利用率连续低于阈值多久才开始累计闲置。 |
| `colabdeck.idleGuard.idleThresholdMinutes` | `5` | 1–120 | 闲置累计多久开始倒计时。 |
| `colabdeck.idleGuard.countdownSeconds` | `120` | 10–3600 | 倒计时长度。 |
| `colabdeck.idleGuard.staleSampleSeconds` | `15` | 5–300 | 样本超过该时长没推进即过期：Idle Guard 转 `DISCONNECTED`，监控标为 stale 并触发探针重启。 |
| `colabdeck.idleGuard.minRuntimeMinutes` | `5` | 0–120 | 连接后的宽限期，期间不检测闲置。 |
| `colabdeck.idleGuard.snoozeMinutes` | `30` | 1–720 | Snooze 时长，也是通知按钮 "Snooze 30m" 的数字。 |
| `colabdeck.idleGuard.autoRelease` | `true` | boolean | 倒计时结束时是否打开官方释放对话框。官方对话框仍需你确认。 |
| `colabdeck.idleGuard.requireKernelIdle` | `auto` | `auto` / `always` / `never` | 倒计时结束时对主内核状态的要求，见 [idle-guard.md](idle-guard.md#不会自动释放的情况)。Marketplace 安装读不到内核状态（Jupyter 按发布者白名单放行 Kernel API），保持 `auto` 即可；`always` 会让倒计时一直停在 `kernel-busy`。 |

判定流程见 [`idle-guard.md`](idle-guard.md)。

## Dashboard

| Key | 默认 | 取值 | 说明 |
| --- | --- | --- | --- |
| `colabdeck.dashboard.timeRange` | `30m` | `15m` / `30m` / `1h` | 默认时间窗。Dashboard 内切换只影响当前 Webview 会话。 |
| `colabdeck.dashboard.showProcesses` | `true` | boolean | 工具箱默认打开 Processes（`true`）还是 Disk（`false`）。 |

## 日志

| Key | 默认 | 取值 | 说明 |
| --- | --- | --- | --- |
| `colabdeck.logging.level` | `info` | `off` / `error` / `warn` / `info` / `debug` / `trace` | 输出面板 **ColabDeck** 的日志级别。 |

## 改动何时生效

- `idleGuard.*`、`logging.level`：立即生效。
- `sampleIntervalMs`、`probeDir`：重启采集，历史缓冲按新容量重建。
- `dashboard.*`：随新的 Dashboard 快照下发。
