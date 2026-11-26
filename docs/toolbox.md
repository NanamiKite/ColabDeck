# 工具箱

Dashboard 下方的工具箱有三个标签页：Processes、Disk、CUDA cache。所有操作都只做下面列出的事。

## Processes：GPU 进程表

列出正在使用 GPU 的进程：PID、名称、命令行、显存。

- 数据来自 `nvidia-smi --query-compute-apps`；`nvidia-smi` 不可用时回退到扫描 `/proc/*/fd`，此时显存列显示 `—`。
- 命令行在宿主侧脱敏：`--token`、`api-key`、`password` 等参数的值被替换。
- 切到该标签页时自动刷新；`colabdeck.dashboard.showProcesses` 决定默认打开 Processes 还是 Disk。

### Kill

点某行的 **Kill**，或在命令面板执行 `ColabDeck: Kill GPU Process...`：

1. VS Code 弹出模态确认 "Stop GPU process <pid>?"，选 **Kill** 才继续。
2. 探针执行前重新查询一次 GPU 进程列表，PID 不在列表里就直接返回 "already gone"，不发信号。
3. 拒绝 `pid <= 1`、探针自身和父进程。
4. 先发 `SIGTERM`，最多等 2 秒；仍存活再发 `SIGKILL`。结果显示是否已终止并验证。
5. 结束后刷新进程表。

## Disk：磁盘扫描

只读列出指定目录下最大的文件，不删除任何东西。

- 路径必须是绝对路径，且 realpath 位于 `/content` 或 `/tmp`，否则拒绝。
- 默认 Top 50（1–1000）、深度 4（0–16）；不跟随符号链接，只统计普通文件。
- 结果按大小降序，超出 Top N 时标记 `truncated`。
- 命令面板入口：`ColabDeck: Scan Disk...`。

## CUDA cache

在 notebook 主内核里执行 `torch.cuda.empty_cache()`，通过 Jupyter 扩展的 Kernel API 下发。

- 需要先在 Jupyter 扩展中允许 ColabDeck 访问内核，否则提示去 Settings 授权。
- 找不到该服务器的活动内核时提示先启动内核。
- 内核正忙时直接报错 "The notebook kernel is busy. Wait for the current cell to finish."，不排队。
- `torch.cuda` 不可用时只打印 "CUDA is not available"。
- 命令面板入口：`ColabDeck: Clear CUDA Cache`。

## 安全边界

- 不调用 Google 私有计费 / 配额接口，不维护 OAuth。
- 不抓包、不模拟 Jupyter / Colab 私有协议，不使用 `/colab/tty`。
- 探针只执行 allowlist 里的命令类型，不执行任意 shell 字符串；超过 5 分钟的命令拒绝。
- 进程终止需要确认；磁盘扫描只读且限制在允许目录内。
- 不向 Webview 发送凭据或未脱敏的连接信息。
- 不实现高频抢卡、假心跳或绕过 90 分钟回收。

命令文件格式与超时规则见 [`protocol.md`](protocol.md#命令队列)。
