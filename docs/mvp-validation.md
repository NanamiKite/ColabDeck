# MVP 现场验收清单

> 以下条目用于真实 Colab runtime 的现场验收。每次验收应记录运行环境、结果和未通过项。

## 环境

- [ ] VS Code stable（>= 1.99.3）
- [ ] 官方 Colab 与 Jupyter 扩展为项目支持版本或最新稳定版
- [ ] 已登录 Colab，已分配 GPU runtime，并执行 **Colab: Mount Server**

## 最小闭环

- [ ] 状态栏出现 `T4 | VRAM x/15G | Idle Guard: ON`，每 5s 更新。
- [ ] 训练 cell 运行 10 分钟期间，Webview 曲线持续更新，不冻结。
- [ ] 训练 cell 执行时间与未安装 ColabDeck 时相比无显著差异（±5%）。
- [ ] GPU 利用率/显存/RAM/磁盘/温度与 `nvidia-smi`、`free -h`、`df -h` 误差 <5%。
- [ ] 点击状态栏打开侧边栏 Dashboard。
- [ ] Dashboard 在默认侧栏宽度下无横向滚动条，拖宽后呈两列布局。
- [ ] Dashboard 的连接状态、采样状态和错误操作可读且可操作。
- [ ] 诊断入口可打开监控日志，且无未处理错误。

## 探针鲁棒性

- [ ] 手动 `kill <probe pid>` 后 15s 内状态栏显示 `STALE`，并在 5/15/30s 退避后自动重启（最多 3 次）。
- [ ] 探针重启后 `bootId` 改变，RingBuffer 清空并从新文件开始。
- [ ] `metrics.jsonl` 超过 2MB 时轮转，Host 检测缩小并重置 offset。
- [ ] 关闭/移除 server 后 Idle Guard 进入 `DISCONNECTED`，绝不调用释放命令。
- [ ] CPU-only runtime 进入 `UNSUPPORTED`，不倒计时。

## Idle Guard

- [ ] GPU 空闲 5 分钟后进入 `IDLE_DETECTED`，UI 显示 `Idle for 2m/5m`。
- [ ] 达到阈值进入 `COUNTDOWN_WARNING`，通知与 Webview 倒计时同步。
- [ ] Webview Cancel / 通知 Cancel / 命令 Cancel 均回到 `ACTIVE` 并重置计时。
- [ ] Snooze 30m 后保持 `ACTIVE`，倒计时取消。
- [ ] `autoRelease=false` 时倒计时结束停在 `phase='expired'`，不调用释放命令。
- [ ] `kernelBusy=true` 且 `requireKernelIdle=auto` 时抑制自动释放；`never` 时仍释放。
- [ ] `autoRelease=true` 时倒计时结束打开官方 `colab.removeServer` QuickPick；确认后 `TERMINATED`，取消后回 `ACTIVE`。
- [ ] 释放过程中 `PROBE_LOST` 不提前把状态打成 `DISCONNECTED`（`TERMINATING` 吸收态）。
- [ ] 扩展宿主重启后不恢复旧倒计时。

## Toolbox

- [ ] GPU 进程表显示 PID/名称/显存；procfs 回退时显存显示 “—”。
- [ ] Kill 前有确认；只允许 GPU 进程列表中的 PID；kill 后列表刷新。
- [ ] 磁盘扫描只允许 `/content`、`/tmp`，返回 top N，不删除文件。
- [ ] CUDA cache 清理通过主内核执行；kernel busy 时明确提示等待；无 Kernel API 权限时提示授权。

## 边界

- [ ] 代码中不出现 `api/colab/resources`、`/colab/tty`、`colabApiClient`、`deleteRuntime`、`v1/user-info`。
- [ ] 探针不 import Jupyter/requests/websocket/torch；`ss -tp`/`lsof` 看不到 Jupyter 连接。
- [ ] 扩展不存储 token/headers；Webview 不接收 `serverSettings`。
- [ ] 不实现周期性 Jupyter 消息，不实现 QuickPick 自动确认。

## 测试矩阵

| 维度 | 取值 |
| --- | --- |
| GPU | T4、L4、A100（如有）、CPU-only |
| Colab 扩展 | 项目支持版本、最新稳定版 |
| Jupyter 扩展 | 项目支持版本、最新稳定版 |
| VS Code | 最低支持版本、当前 stable |
| Python | 3.10、3.11、3.12 |
| 工作区 | 单 folder、多 root、无 folder |
| 服务器数量 | 1、2 |
| 探针状态 | 正常、stale、崩溃、重启、runtime 回收 |
| Idle Guard | active、idle、countdown、cancel、snooze、release、stale、kernel busy |
| 释放 | 确认、取消、多服务器、命令不可用 |
| 主题 | light、dark、high contrast |
