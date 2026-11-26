# ColabDeck 协议速查

完整设计见 [`phase-1-architecture.md`](phase-1-architecture.md)。本文只记录实现中实际使用的形状。

## 远端文件

```text
/content/.colabdeck/
  colabdeck_probe.py
  status.json          原子覆盖，探针健康快照
  metrics.jsonl        NDJSON；每行一个 SAMPLE/BYE
  metrics.1.jsonl      2MB 轮转后的上一份
  probe.log
  probe.lock           fcntl 单实例锁
  probe.pid
  commands/<requestId>.json
  results/<requestId>.json
```

约束：

- `protocol = 1`；`bootId` 为探针启动 UUID，重启后变化。
- `timestampMs` 是 Colab runtime 的 epoch 毫秒；Host 另记 `receivedAtMs`。
- `status.json` 每个采样周期 `tmp + os.replace` 原子覆盖。
- `metrics.jsonl` 只追加；超过 2MB 轮转，Host 检测文件缩小后重置读取偏移。
- 读取方只解析到最后一个完整 `\n`；半行留到下一次。
- 探针只用 Python 标准库，不连接 Jupyter/网络。

## 命令队列

Host 写 `commands/<requestId>.json.tmp`，再 rename 为 `.json`。探针每 500ms 扫描，执行 allowlist 动作，写 `results/<requestId>.json`，删除命令文件。

```ts
type ProbeCommand =
  | { type: 'LIST_GPU_PROCESSES'; protocol: 1; requestId: string; issuedAtMs: number }
  | { type: 'KILL_PROCESS'; protocol: 1; requestId: string; issuedAtMs: number; pid: number }
  | { type: 'SCAN_DISK'; protocol: 1; requestId: string; issuedAtMs: number; path: string; maxEntries: number; maxDepth: number }
  | { type: 'GET_PROBE_STATUS'; protocol: 1; requestId: string; issuedAtMs: number }
  | { type: 'STOP'; protocol: 1; requestId: string; issuedAtMs: number };
```

- 超过 5 分钟的命令拒绝。
- `KILL_PROCESS` 只接受最近 GPU 进程列表中的 PID；拒绝 `pid <= 1`、自身、父 PID。
- `SCAN_DISK` 的 realpath 必须位于 `/content` 或 `/tmp`。

## Webview 消息

`Webview → Host`：

```text
READY, REQUEST_SNAPSHOT, SELECT_SERVER,
IDLE_GUARD_CANCEL, IDLE_GUARD_SNOOZE, IDLE_GUARD_RELEASE_NOW, IDLE_GUARD_SET_ENABLED,
REFRESH_GPU_PROCESSES, KILL_PROCESS, CLEAR_CUDA_CACHE, SCAN_DISK,
DISMISS_ERROR, MOUNT_COLAB_SERVER, RELOAD_WINDOW,
OPEN_SETTINGS, OPEN_PROBE_LOG, RETRY_PROBE
```

`Host → Webview`：

```text
PROTOCOL_MISMATCH, SNAPSHOT, TELEMETRY_BATCH, TELEMETRY_APPEND,
IDLE_GUARD_STATE, GPU_PROCESSES, TOOLBOX_RESULT, ERROR, SETTINGS_CHANGED
```

- Host 用 `webviewToHostMessageSchema`（zod）校验所有入站消息；未知 type 丢弃并记录。
- `READY.protocol !== 1` 时只发送 `PROTOCOL_MISMATCH`。
- Webview 隐藏时 Host 继续采样；恢复可见时补发 `SNAPSHOT` + `TELEMETRY_BATCH`。
- 下采样：VRAM/温度取桶内 `max`，利用率取 `avg`，最多 600 点。

## Idle Guard 状态

`DISABLED | DISCONNECTED | SYNCING | ACTIVE | IDLE_DETECTED | COUNTDOWN_WARNING | TERMINATING | TERMINATED | ERROR | UNSUPPORTED`

- 每次转换输出结构化日志，包含 `from/to/event/reason/gpu/threshold/idleFor/sampleAge/kernelBusy`。
- `TERMINATING` 是吸收态：等待 release 结果期间忽略 `PROBE_LOST`/`SERVER_DISCONNECTED`/stale。
- `DISABLED` 是吸收态：除启用外忽略所有运行时事件。
- 任何 stale/断连优先转 `DISCONNECTED`，绝不释放。
- 状态不持久化；扩展宿主重启后从 `DISCONNECTED` 开始。
