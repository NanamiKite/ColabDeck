# Idle Guard

Idle Guard 盯着 GPU 利用率：连续低于阈值就算闲置，闲置够久开始倒计时，倒计时结束打开官方释放对话框。释放仍由你在对话框中确认。

## 判定流程

```text
连接成功 ──▶ SYNCING ──首个含 GPU 的新鲜样本──▶ ACTIVE
                                                 │
           GPU 利用率 ≥ 阈值，或处于宽限期 / Snooze：保持 ACTIVE
                                                 │
           GPU 利用率 < 阈值并持续 idleDebounceMs（默认 5 s）
                                                 ▼
                                         IDLE_DETECTED
                                         显示 Idle for Xm (limit Ym)
                                                 │
                                 闲置累计达到 idleThresholdMinutes（默认 5 分钟）
                                                 ▼
                                      COUNTDOWN_WARNING
                                      通知 + 状态栏倒计时（默认 120 s）
                      ┌────────────────────┼────────────────────┐
                   Cancel               Snooze 30m         Release now / 倒计时结束
                      │                     │                        │
                   ACTIVE              ACTIVE，到 snoozedUntil   打开官方 colab.removeServer 对话框
                                        之前不再检测              ├─ 服务器消失 → TERMINATED
                                                                 └─ 服务器仍在 → ACTIVE
```

- 闲置计时从 GPU 首次低于阈值开始，包含去抖时间。
- 连接后 `minRuntimeMinutes`（默认 5 分钟）内不检测。
- `IDLE_DETECTED` 或 `COUNTDOWN_WARNING` 期间 GPU 利用率回到阈值以上，回到 `ACTIVE`。
- GPU 利用率读不到（`null`）时保持 `ACTIVE`，不进入 idle。
- runtime 没有 GPU 时进入 `UNSUPPORTED`，不倒计时。

## 状态

| 状态 | 含义 | 状态栏 |
| --- | --- | --- |
| `DISABLED` | `colabdeck.idleGuard.enabled` 为 `false` | `OFF` |
| `DISCONNECTED` | 没有选中服务器，或样本过期 / 断连 | `—` |
| `SYNCING` | 已连接，等首个 GPU 样本 | `STARTING` |
| `ACTIVE` | GPU 在用，或处于宽限期 / Snooze | `ON` |
| `IDLE_DETECTED` | 闲置累计中 | `IDLE 2m` |
| `COUNTDOWN_WARNING` | 倒计时中 | `RELEASE 1m32s`；`expired` / `kernel-busy` 时显示 `RELEASE?` |
| `TERMINATING` | 等待释放对话框结果 | `STOPPING` |
| `TERMINATED` | 服务器已释放 | `RELEASED` |
| `ERROR` | 释放命令失败 | `ERROR` |
| `UNSUPPORTED` | runtime 没有 GPU | `N/A` |

`TERMINATING` 和 `DISABLED` 是吸收态：前者等待结果期间忽略 `PROBE_LOST`、`SERVER_DISCONNECTED` 和过期样本；后者除重新启用外忽略所有事件。

## 倒计时结束时发生什么

1. 扩展调用官方命令 `colab.removeServer`，官方 QuickPick 弹出。
2. 同时显示提示 "ColabDeck opened the Colab release dialog. Confirm the server there."，附 **Open Colab** 按钮。
3. 你确认：服务器从列表消失（最多等 5 秒）→ `TERMINATED`。你取消：服务器仍在 → 回 `ACTIVE`，闲置计时重置。命令失败：→ `ERROR`。

扩展不会替你按 Enter。

## 不会自动释放的情况

- 样本过期（`staleSampleSeconds`，默认 15 秒）、断连或没有 GPU：转 `DISCONNECTED` 或 `UNSUPPORTED`，不调用释放。
- `autoRelease=false`：倒计时结束停在 `COUNTDOWN_WARNING`，`phase='expired'`，直到你点 **Release now**。
- `requireKernelIdle` 没通过：停在 `phase='kernel-busy'`，提示 "Notebook is busy; release will wait."

停在 `expired` / `kernel-busy` 时，修改任一 ColabDeck 设置会重新判定；条件满足就立刻打开对话框。

| `requireKernelIdle` | 倒计时结束时允许打开对话框的条件 |
| --- | --- |
| `never` | 总是 |
| `always` | 主内核状态明确为 idle |
| `auto`（默认） | 主内核状态不是 busy；读不到内核状态时也放行 |

内核状态只在 `IDLE_DETECTED` 和 `COUNTDOWN_WARNING` 期间查询，5 秒内没结果按 `null` 处理；`requireKernelIdle=never` 时不查询。

**Marketplace 安装的限制**：Jupyter 扩展按发布者白名单放行 Kernel API，ColabDeck 不在名单里，所以内核状态**读不到**，始终按 `null` 处理。效果：`auto`（默认）不受影响，照常放行；`always` 永远等不到 "明确 idle"，倒计时会一直停在 `kernel-busy`，不要用。ColabDeck 不会为此主动请求 Kernel API，也不会触发 Jupyter 的授权弹窗。

## 操作入口

- Webview Idle Guard 卡片：Cancel / Snooze Xm / Release now。卡片显示阈值、已闲置时长；Snooze 后显示 `Snoozed until` 时间。
- 倒计时通知："Colab GPU looks idle. The Colab release dialog will open in 2m."，同样三个按钮。
- 命令面板：`ColabDeck: Cancel Idle Countdown`、`ColabDeck: Snooze Idle Guard`、`ColabDeck: Release Colab Server Now`。

Snooze 时长由 `colabdeck.idleGuard.snoozeMinutes` 决定。Snooze 期间保持 `ACTIVE`，到点后恢复检测。

## 其他

- 状态不持久化，扩展宿主重启后从 `DISCONNECTED` 开始。
- 每次状态转换写一条结构化日志到输出面板 **ColabDeck**，含 `from/to/event/reason/gpu/threshold/idleFor/sampleAge/kernelBusy`。
- 完整转换表见 [`phase-1-architecture.md` § 3.3](phase-1-architecture.md#33-idle-guard-状态机)。
