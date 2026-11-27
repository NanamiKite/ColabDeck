# 监控

Dashboard 的指标由运行在 Colab runtime 内的采集进程（下称探针）写入文件，扩展宿主读取后推给 Webview。探针是独立进程，不经过 notebook 主内核，所以训练 cell 占用内核时曲线照常刷新。

## 显示哪些指标

| 形式 | 指标 | 来源 |
| --- | --- | --- |
| 曲线 | GPU 利用率 | `nvidia-smi --query-gpu` |
| 曲线 | VRAM 已用 | `nvidia-smi --query-gpu` |
| 曲线 | 系统 RAM 已用 | `/proc/meminfo` |
| 曲线 | 磁盘已用 | `statvfs`（探针目录所在文件系统） |
| 读数 | GPU 温度（≥ 85 °C 标红） | `nvidia-smi --query-gpu` |
| 读数 | GPU 功耗 | `nvidia-smi --query-gpu` |
| 读数 | CPU load（1 分钟负载 / 逻辑核数） | `os.getloadavg()` |

VRAM 另有 **Window peak**：当前时间窗内观测到的显存最大值。读数只显示最新样本，不画曲线；采不到时显示 `—`。

## Colab 实际能给什么

- GPU 利用率、显存、温度、功耗：`nvidia-smi` 在 T4、L4、A100 上通常都有；温度或功耗列可能返回 `[N/A]`，该读数显示 `—`。
- CPU 负载：`os.getloadavg()`，任何 Linux runtime 都可用。
- CPU 温度：探针会读 thermal zone 和 hwmon，云 VM 上通常读不到，Dashboard 不显示。
- 官方 Colab 扩展的 Resources 视图走未文档化的 `api/colab/resources`，只有 RAM、磁盘、GPU RAM。ColabDeck 不调用它，也不读私有的 `v1/user-info`，所以不显示算力点余额。

## 采集过程

1. 点击 **Mount server** 只挂载服务器。点击 **Start Monitoring** 后，ColabDeck 优先接入正在采样的探针。首次启动需要在官方 Colab 扩展里为当前服务器打开终端，等终端连上后点 **Retry Monitoring**。ColabDeck 将 `colabdeck_probe.py` 写入远端 `probeDir`（默认 `/content/.colabdeck`），在唯一匹配的现有官方终端中用 `nohup` 启动后台探针，不打开、隐藏或关闭终端。
2. 探针按 `colabdeck.probe.sampleIntervalMs`（默认 5000 ms）采样，追加到 `metrics.jsonl`，并原子覆盖 `status.json`。
3. 宿主通过官方 `colab://` 文件系统按偏移增量读取 `metrics.jsonl`，只解析到最后一个完整换行。
4. Webview 收到新样本后更新曲线。Webview 隐藏时宿主继续采样，恢复可见时补发快照和批量数据。

探针只用 Python 标准库，不连接 Jupyter，也不访问网络。文件格式、2 MB 轮转和命令队列见 [`protocol.md`](protocol.md)。

**Refresh** 和时间窗切换只更新面板，不启动或重启探针。切换服务器只停止读取原服务器的数据，不停止远端探针；要开始监控新服务器，请点击 **Start Monitoring**。

## 时间窗与下采样

- 宿主为每个服务器保留最近 1 小时的样本，容量 = `ceil(1h / 采样间隔)`，限制在 60–3600 个。
- Dashboard 右上角可选 15m / 30m / 1h，初始值由 `colabdeck.dashboard.timeRange` 决定。
- 绘图前下采样到最多 600 点：VRAM 和温度取桶内最大值，利用率取平均值。
- 新样本追加后，按所选时间窗裁掉窗口外的点。

## 新鲜度

GPU 卡片顶部显示 `Last sample Xs ago`。以下任一情况会标为过期并置灰：

- 最新样本距今超过 15 秒；
- 连接状态为 `disconnected`、`stale` 或 `error`。

样本序号超过 `colabdeck.idleGuard.staleSampleSeconds`（默认 15 秒）没有推进时，Idle Guard 暂停。ColabDeck 不会自动重启探针；可以点击面板头部的 **Retry Monitoring** 重新连接。如需重启探针，请在命令面板运行 `ColabDeck: Restart Monitoring`。

## 启动采集的前提

- 官方 `colab://` 文件系统以 `/content` 为根，所以 `colabdeck.probe.probeDir` 必须是 `/content` 下的绝对路径，不能包含 `..`。
- 启动新探针需要开启官方设置 `colab.terminal`，并手动打开与当前服务器匹配的官方终端。复用正在采样的探针不需要终端。
- 改动 `sampleIntervalMs` 或 `probeDir` 不会重启正在运行的探针。要应用到现有探针，在命令面板运行 `ColabDeck: Restart Monitoring`。

## 诊断

- 状态栏：`<GPU> | VRAM 已用/总量 | Idle: <状态>`，点击打开 Dashboard。
- 输出面板 **ColabDeck**：激活、探针启动、Idle Guard 状态转换和错误。
- 错误卡 **View diagnostics**：打开远端 `probe.log`。
