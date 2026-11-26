# ColabDeck

官方 **Google Colab** VS Code 扩展（`google.colab`）的伴生运维与成本风控面板。它不重复实现连接、登录或配额逻辑，只补齐三类能力：

1. **非阻塞时序监控**：GPU 利用率、显存（含窗口峰值）、系统 RAM、`/content` 磁盘剩余，以及 GPU 温度/功耗读数。采集不依赖训练中的主内核同步执行，训练期间 Dashboard 仍可更新。
2. **Idle Guard**：GPU 连续低于阈值时累计闲置时间，达到阈值后倒计时提醒；可一键取消/延后，倒计时结束自动打开官方释放对话框（Assisted Release）。
3. **轻量排障工具箱**：GPU 进程列表、受校验的 Kill、只读磁盘大文件扫描、主内核 CUDA 缓存清理。

[快速开始](#快速开始) · [配置](#配置) · [Idle Guard](#idle-guard-行为) · [文档](#文档) · [开发](#开发)

## 快速开始

前置条件：

- Node.js >= 20，npm >= 10
- VS Code >= 1.99.3
- 已安装并登录官方扩展：
  - `google.colab`（Colab）
  - `ms-toolsai.jupyter`（Jupyter）
- Python >= 3.10（探针在 Colab runtime 上运行；本机运行 pytest 需要 pytest）

1. 克隆仓库并执行 `npm install`。
2. 在 VS Code 中打开仓库，按 `F5`（已提供 `.vscode/launch.json`），或执行 `npm run package:vsix` 后安装 VSIX。
3. 在官方 Colab 扩展中分配 runtime。
4. 点击活动栏或状态栏打开 ColabDeck Dashboard，再点击 **Mount server**。
5. 连接状态变为 `connected` 后，图表会自动开始更新。

Dashboard 默认在侧边栏打开，拖宽后呈两列布局。如果长时间显示 `Starting`，先点击 **Refresh**；仍失败时点击错误卡中的 **Retry**，需要诊断信息时点击 **View diagnostics**。连接处于 `error`、`stale`，或已选择服务器但处于 `disconnected` 时，头部还会出现 **Restart probe**。

### F5 闪退（退出码 134）

如果按 `F5` 后 Extension Development Host 在几秒内退出并显示退出码 `134`，请先关闭 VS Code 的实验性 JavaScript Network 视图。

仓库已在 `.vscode/settings.json` 默认关闭该实验性视图。若仍遇到闪退，请确认工作区设置中 `debug.javascript.enableNetworkView` 为 `false`，重启 VS Code 后再次按 `F5`。需要 Network 视图时可改回 `true`，但可能重新遇到该版本 VS Code 的问题；升级到包含修复的 VS Code 后再开启。

## 配置

| Key | 默认 | 说明 |
| --- | --- | --- |
| `colabdeck.probe.sampleIntervalMs` | `5000` | 采样间隔，1–60s |
| `colabdeck.probe.launchMethod` | `auto` | 采集器启动方式 |
| `colabdeck.probe.probeDir` | `/content/.colabdeck` | 远端监控数据目录，必须位于 `/content` 下 |
| `colabdeck.idleGuard.enabled` | `true` | Idle Guard 总开关 |
| `colabdeck.idleGuard.gpuUtilizationThresholdPct` | `5` | 低于该利用率视为 idle |
| `colabdeck.idleGuard.idleDebounceMs` | `5000` | 连续低利用率去抖 |
| `colabdeck.idleGuard.idleThresholdMinutes` | `5` | 连续 idle 多久开始倒计时 |
| `colabdeck.idleGuard.countdownSeconds` | `120` | 倒计时长度 |
| `colabdeck.idleGuard.staleSampleSeconds` | `15` | 样本过期即失效安全 |
| `colabdeck.idleGuard.minRuntimeMinutes` | `5` | 连接后的宽限期 |
| `colabdeck.idleGuard.snoozeMinutes` | `30` | Snooze 时长 |
| `colabdeck.idleGuard.autoRelease` | `true` | 倒计时结束自动打开官方释放对话框 |
| `colabdeck.idleGuard.requireKernelIdle` | `auto` | `auto` / `always` / `never` |
| `colabdeck.dashboard.timeRange` | `30m` | 默认时间窗 |
| `colabdeck.dashboard.showProcesses` | `true` | 是否默认打开 GPU 进程表 |
| `colabdeck.logging.level` | `info` | 输出通道日志级别 |

## Idle Guard 行为

Idle Guard 会在 GPU 持续低利用率时显示倒计时，并提供取消、延后和释放操作。官方释放对话框仍需用户确认；监控失效、断连或无 GPU 时不会自动释放。

## 安全与边界

- 不调用 Google 私有计费/配额接口，不维护 OAuth。
- 不抓包、不模拟 Jupyter/Colab 私有协议；不使用 `/colab/tty` 私有接口。
- 不实现高频抢卡、假心跳或绕过 90 分钟回收。
- 采集器只读运行时指标，不维护登录态、不执行任意远端命令。
- 进程终止需要确认，磁盘扫描只读且限制在允许目录内。
- 不向 Webview 发送凭据或未脱敏的敏感连接信息。

## 已知限制

- 官方释放操作需要用户在对话框中确认；自动释放是 Assisted Release，不是无人值守释放。
- 启动采集时官方终端可能短暂可见。
- 当前一次只监控一个选中的服务器。
- 真实 Colab 验收请按 [`docs/mvp-validation.md`](docs/mvp-validation.md) 执行。

## 文档

- [`docs/phase-1-architecture.md`](docs/phase-1-architecture.md)：完整架构、契约、状态机与决策记录。
- [`docs/protocol.md`](docs/protocol.md)：探针文件、命令队列与 Webview 协议速查。
- [`docs/mvp-validation.md`](docs/mvp-validation.md)：现场验收清单。

## 开发

```bash
npm install
npm run build
npm run typecheck
npm test
```

`npm test` 依次运行 shared/extension 的 Vitest 与 `packages/probe` 的 pytest。若本机没有全局 pytest，可使用：

```bash
uv venv .venv
uv pip install --python .venv/bin/python pytest
.venv/bin/python -m pytest packages/probe -q
```

可选地运行 `npm run test:smoke` 检查桌面版 VS Code 中的扩展激活；该命令不连接真实 Colab runtime。

### 架构

```text
packages/
  shared/      协议类型、zod 校验、RingBuffer、Idle Guard 纯 reducer
  probe/       colabdeck_probe.py（仅标准库，运行在 Colab runtime）
  extension/   Extension Host：发现、安装/启动探针、采样、状态栏、Webview、Idle Guard
  webview/     Preact + uPlot Dashboard
```

Extension Host 通过官方 Colab 工作区和独立后台采集器读取遥测；采集不依赖训练中的主内核同步执行，因此训练期间 Dashboard 仍可更新。
