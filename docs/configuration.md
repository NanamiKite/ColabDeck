# 配置

所有设置都是 window 作用域。在 VS Code Settings 里搜 `colabdeck`，或直接改 `settings.json`。

## 探针

| Key | 默认 | 取值 | 说明 |
| --- | --- | --- | --- |
| `colabdeck.probe.sampleIntervalMs` | `5000` | 1000–60000 | 两种来源的采样间隔。Mounted runtime 下 `metrics.jsonl` 增长更快；Notebook 来源在下一次 Start 时把该间隔传给私有采集器。 |
| `colabdeck.probe.probeDir` | `/content/.colabdeck` | 绝对路径 | 探针在远端的目录，必须在 `/content` 下，不能含 `..`。 |

Mounted runtime 启动新探针需要预先打开当前服务器的官方 Colab 终端，等它连上。ColabDeck 只向唯一匹配的现有官方终端发送启动命令，不会自行打开或关闭终端。探针已在采样时，可以直接接入，无需终端。Notebook 来源不使用 `probeDir` 或官方终端；它从当前 Python notebook 启动私有采集器，并在下一次 Start 时读取新的采样间隔。

## Idle Guard

| Key | 默认 | 取值 | 说明 |
| --- | --- | --- | --- |
| `colabdeck.idleGuard.enabled` | `true` | boolean | 总开关。关闭后立即取消计时器。 |
| `colabdeck.idleGuard.gpuUtilizationThresholdPct` | `5` | 0–100 | GPU 利用率低于该值视为闲置。 |
| `colabdeck.idleGuard.idleDebounceMs` | `5000` | 1000–600000 | 利用率连续低于阈值多久才开始累计闲置。 |
| `colabdeck.idleGuard.idleThresholdMinutes` | `5` | 1–120 | 闲置累计多久开始倒计时。 |
| `colabdeck.idleGuard.countdownSeconds` | `120` | 10–3600 | 倒计时长度。 |
| `colabdeck.idleGuard.staleSampleSeconds` | `15` | 5–300 | 样本超过该时长未更新，Idle Guard 转为 `DISCONNECTED`。不会自动重启探针。 |
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
- `sampleIntervalMs`、`probeDir`：在下次手动启动或重启监控时生效。
- `dashboard.*`：随新的 Dashboard 快照下发。
