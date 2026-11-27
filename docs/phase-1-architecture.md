# ColabDeck — 架构设计与契约定义

> 本文定义 ColabDeck 的稳定架构、边界与契约。具体版本兼容性和现场验证结果不作为架构规范的一部分。启动流程以“当前实现”段落为准；早期草图中的自动终端启动方案已废弃。

---

## 0. 结论摘要（TL;DR）

1. **官方 Colab 扩展没有可用的 `exports`。** `activate()` 返回 `undefined`，内部 `assignmentManager`、`colabApiClient`、`serverCollection` 均未导出。我们不能依赖 `extension.exports`。
2. **官方暴露的公共集成面只有三类**：贡献命令、`colab://` 文件系统、Jupyter 扩展的公共 Kernel API；官方状态栏/树视图对第三方不可读。
3. **推荐主通道**：通过官方 `colab://<serverId>/content/...` 文件系统写入一个独立后台探针 `colabdeck_probe.py`，复用用户已为当前服务器打开的、名称精确匹配的官方 Colab 终端发送启动命令；ColabDeck 不调用 `colab.openTerminal`，不打开、隐藏或销毁终端。探针只读写本地文件，不连接 Jupyter、不产生心跳。扩展宿主用 `workspace.fs` 轮询 `metrics.jsonl`。这条链路**不调用任何 Google 私有接口**。
4. **可选的 Jupyter 通道**：`ms-toolsai.jupyter` 的 `getKernelService()` 可读取活动 Colab kernel 状态，并为需要主内核的可选工具提供能力；它需要用户一次性授予 Jupyter Kernel API 权限，拒绝时必须能完整降级。监控探针不从 notebook kernel 启动。
5. **Idle Guard 的释放需要用户确认**：ColabDeck 只调用官方释放命令并等待其结果，不模拟或自动确认官方对话框。
6. **MVP 最小闭环**：挂载/发现 server → 写入并启动探针 → 读取 JSONL → RingBuffer → 状态栏 → Webview。这个闭环不需要 Jupyter Kernel API 授权，也不需要任何私有接口。
7. **明确不做**：不调用 `api/colab/resources`、`/colab/tty`、`colabApiClient`、计费/配额接口；不维护 Google OAuth；不实现保活心跳；不用主内核同步执行 `nvidia-smi`。

---

## 1. 官方插件集成面分析

### 1.1 集成约束与公共接口

| 集成面 | 核实结果 | 证据/说明 | 我们是否使用 |
| --- | --- | --- | --- |
| `google.colab` 的 `exports` | **无** | bundle 末尾为 `0&&(module.exports={activate})`；`activate()` 内部 `uB()` 不返回对象 | 否 |
| `google.colab` 的 `activate()` 返回值 | `undefined` | 同上 | 否 |
| `assignmentManager` / `serverCollection` | 仅内部持有 | `dE()` 返回给 `uB()`，未导出 | 否 |
| 贡献命令 `colab.openTerminal` | 公开命令 | 处理器 `fR`：一个服务器直接打开；多个则 QuickPick；`mR` 用 `ColabPseudoterminal` 连接 `/colab/tty` | 否（仅由用户手动打开终端） |
| 贡献命令 `colab.removeServer` | 公开命令 | 处理器 `OE`：先 `getServers("all")`，有服务器时随后**总是** `showQuickPick`；确认后 `unassignServer` | **是**（Idle Guard 释放，需用户确认） |
| 贡献命令 `colab.mountServer` | 公开命令 | 处理器 `CE`：把 `colab://<serverId>/content` 加入 workspace folders | **是**（serverId 发现的降级方案） |
| 贡献命令 `colab.toolbarCommand` | 公开命令 | QuickPick 菜单（View Existing Servers / Auto Connect / New Server / Open Web） | 否 |
| 贡献命令 `colab.refreshServerResourceView` | 公开命令 | 只刷新官方 Resources 树，不返回数据 | 否 |
| `colab.hasAssignedServer` / `colab.isSignedIn` | context key | 只能用于 `when` 子句，其他扩展不可直接读取 | 否（不依赖） |
| 官方状态栏 `colab.consumptionStatusBar` | 状态栏项 | `StatusBarAlignment.Right`，默认 priority；显示算力消耗 | 否（不冲突、不重复计费信息） |
| `ms-toolsai.jupyter` 的 `activate()` | 返回公共 API 对象 | 包含 `ready`、`getKernelService`、`kernels`、`createJupyterServerCollection` 等 | **是**（可选） |
| `getKernelService()` | 受授权门控 | `qI.getService()` 先检查 `apiAccess.getAccessInformation()`；拒绝则返回 `undefined` | **是**（可选，需一次性授权） |
| `getActiveKernels()` | 公共服务方法 | 返回 `{ metadata, uri, id }[]`；远端 kernel 的 `metadata` 含 `baseUrl`、`serverProviderHandle`、`kernelModel` | **是**（自动发现） |
| `getKernel(uri)` | 公共服务方法 | 返回 `{ metadata, connection }`；`connection.serverSettings` 为已认证的 Jupyter ServerSettings | **是**（可选隐形启动） |
| `kernels.getKernel(uri)` | 受授权门控 | 返回 `IApiKernel`（`executeCode`、`shutdown`、`status`） | **是**（清理 CUDA 缓存等主内核动作） |
| `colab://` FileSystemProvider | 公共 VS Code API | scheme=`colab`，authority=serverId，path 以 `/content` 开头；走 Jupyter Contents API，带官方认证 | **是**（核心数据/命令通道） |
| `api/colab/resources` | Colab 运行时端点 | 官方 Resources 视图使用；返回 RAM/disk/GPU 显存与利用率，但不含温度/进程 | **否**（非标准、未文档化） |
| `/colab/tty` | Colab 运行时端点 | 官方终端 WebSocket；需要 Colab 专用认证头与协议 | **否**（不自行实现） |
| `colabApiClient.listAssignedRuntimes/getRuntime/deleteRuntime` | Google 私有运行时 API | 官方扩展内部使用 | **否**（严禁调用） |
| 计费/配额接口 `v1/user-info` 等 | Google 私有 API | 官方扩展内部使用 | **否**（严禁调用） |

### 1.2 `google.colab` 的公共命令

官方扩展贡献的相关公共命令包括：

```text
colab.openTerminal                 # 打开连接到 Colab runtime 的终端
colab.removeServer                 # 选择并移除一个 assigned server（交互式）
colab.mountServer                  # 把 server 的 /content 挂到 workspace
colab.toolbarCommand               # Colab 快速菜单
colab.refreshServerContentView     # 刷新官方 Contents 树
colab.refreshServerResourceView    # 刷新官方 Resources 树
colab.signOut                      # 退出 Google 登录
colab.mountDrive / colab.upload / colab.download / ...
```

#### 1.2.1 `colab.openTerminal` 的实际行为

- 处理器 `fR` 先调用 `assignmentManager.getServers("extension")`。
- 只有一个服务器时直接打开；多个时弹 QuickPick；没有时显示信息提示。
- 终端由 `window.createTerminal({ name: server.label, pty: ColabPseudoterminal, iconPath })` 创建。
- `ColabPseudoterminal` 通过 `ColabTerminalWebSocket` 连接 `/colab/tty`，不是标准 Jupyter `/api/terminals`。
- 稳定 VS Code API **不能读取**这个自定义 PTY 的输出（`onDidChangeTerminalData` 是 proposed API；shell integration 也不会注入到自定义 PTY）。
- 因此 ColabDeck 不自行调用它，也不解析终端输出；用户先用该命令打开匹配终端后，ColabDeck 只复用这个已存在的终端启动 detached 探针。

#### 1.2.2 `colab.removeServer` 的实际行为

- 处理器 `OE` 先 `getServers("all")`，把 assigned 与 unowned 服务器都列出来。
- **只要存在服务器，无论有几个都会 `showQuickPick`**；选择后调用 `unassignServer`。
- `unassignServer` 会删除 Jupyter sessions、删除 runtime、更新 storage，并触发 `onDidAssignmentsChange`。
- 结论：我们可以 `await vscode.commands.executeCommand('colab.removeServer')`，该 Promise 会在用户确认或取消后 resolve；但我们**不能**从扩展侧安全地预选/确认 QuickPick。

#### 1.2.3 `colab.mountServer` 的实际行为

- 处理器 `CE`：一个服务器时直接 `mount`；多个时 QuickPick。
- `mount` 把 `colab://<serverId>/content` 作为 workspace folder 加入，名字为 `server.label`。
- 如果已经挂载，直接返回；如果当前没有 workspace，可能触发打开文件夹/重载。
- 这是我们**无需 Jupyter API 授权**即可拿到 serverId 的主要降级路径。

### 1.3 `ms-toolsai.jupyter` 的公共 API

`vscode.extensions.getExtension('ms-toolsai.jupyter')?.exports` 返回一个对象，已核实包含：

```ts
interface JupyterExtensionApi {
  readonly ready: Promise<void>;
  getKernelService(): Promise<ExportedKernelService | undefined>;
  readonly kernels: {
    getKernel(uri: Uri): Promise<ApiKernel | undefined>;
    readonly onDidStart: Event<...>;
  };
  createJupyterServerCollection(...): ...; // 提供者 API，不用于消费
  // ...其余为 Python 环境等无关 API
}
```

`getKernelService()` 的授权门控：

- 首次调用会弹出 Jupyter 扩展的模态授权：“是否允许 <扩展名> 访问 Jupyter Kernel API”。
- 用户选择 Allow 后，结果写入 Jupyter `globalState`（键 `JUPYTER_API_ACCESS_INFORMATION`）。
- 拒绝后返回 `undefined`；可通过命令 `jupyter.manageAccessToKernels` 重新管理。
- 非 trusted workspace 直接拒绝。

活动 kernel 的 metadata 形状（已核实）：

```ts
interface ActiveKernel {
  readonly metadata: {
    readonly kind: 'connectToLiveRemoteKernel' | 'startUsingRemoteKernelSpec' | ...;
    readonly baseUrl?: string;
    readonly serverProviderHandle?: {
      readonly extensionId: string; // 'google.colab'
      readonly id: string;          // 'colab' collection id
      readonly handle: string;     // Colab serverId，即 colab:// 的 authority
    };
    readonly kernelModel?: {
      readonly id?: string;
      readonly name?: string;
      readonly last_activity?: string;
    };
  };
  readonly uri?: Uri;
  readonly id: string;
}
```

> **注意**：`getActiveKernels()` 的实现包含 `startedAtLeastOnce` 的 kernel，可能包含已经停止的会话。使用前必须调用 `getKernel(uri)` 并检查 `connection` / `status`，不能只凭列表判断“活跃”。

`getKernel(uri)` 的 `connection` 是对 Jupyter `ISession` 的 Proxy：

- `connection.serverSettings`：包含 `baseUrl`、`wsUrl`、`token`、`appendToken`、`init`、`fetch`、`WebSocket`、`Request`、`Headers`。
- Colab 的 `fetch` 与 `WebSocket` 是官方扩展注入的包装器，会自动带上 `X-Colab-Runtime-Proxy-Token` 等认证头。
- 因此我们可以把 `serverSettings` 交给 `@jupyterlab/services` 的 `KernelManager` / `SessionManager` / `ContentsManager`，**不需要自己处理 token**。
- `serverSettings.token` 可能为空；Colab 的认证主要在 `fetch` / `WebSocket` 包装器里，不要假设 token 一定存在。
- 只在 bootstrap 时复制 `serverSettings`；不要长期持有 `connection` / `ISession`，kernel 会话结束会导致对象失效。

### 1.4 `colab://` FileSystemProvider

URI 形式：

```text
colab://<serverId>/content/<path>
```

已核实的操作：

- `stat`、`readDirectory`、`readFile`、`writeFile`、`createDirectory`、`delete`、`rename`、`watch`。
- `readFile` 通过 Jupyter Contents API（`format=base64`）读取后解码。
- `writeFile` 通过 Contents API `save`（`format=base64`）写入。
- `rename` 支持，但要求 source/target 的 authority 相同（同一服务器）。
- `createDirectory` 通过 Contents API `save` 创建目录。
- 所有操作都要求官方扩展处于 `isAuthorized`，且 serverId 能在 `getServers("extension")` 中找到。
- `workspace.fs` 的轮询使用官方扩展缓存的 Jupyter client；不会每次调用 Colab API。只有 client 首次创建或失效时才会触发 `getServers("extension")`。

**关键结论**：只要我们知道 serverId，就可以在不挂载 workspace folder 的情况下使用 `workspace.fs` 访问 `colab://<serverId>/content/...`。挂载只是发现 serverId 的一种方式，不是使用 FS provider 的前提。

### 1.5 明确不使用的私有接口

| 接口 | 为什么不用 |
| --- | --- |
| `api/colab/resources` | 未文档化的 Colab 运行时端点；虽然官方 Resources 视图用它，但不含温度/进程，且不符合“只使用公共接口”的边界。我们用标准 Jupyter Contents API + 自己的探针替代。 |
| `/colab/tty` | 官方终端专用 WebSocket，需要复刻 Colab 认证头与协议；由官方终端管理，ColabDeck 不直接调用或实现。 |
| `colabApiClient.*` | Google 私有运行时 API；禁止抓包/模拟。释放只调用官方 `colab.removeServer` 命令。 |
| 计费/配额 API | 严禁调用；状态栏只显示硬件与 Idle Guard 状态，不显示算力余额。 |
| `colab.consumptionStatusBar` 的数据 | 其他扩展无法读取；也不应重复官方的计费展示。我们使用独立的状态栏项与优先级。 |

### 1.6 降级采集方案矩阵

| 场景 | serverId 发现 | 数据通道 | 探针启动 | 说明 |
| --- | --- | --- | --- | --- |
| **A. Jupyter API 已授权 + 有活动 Colab kernel** | 当前挂载的 `workspace.workspaceFolders` 中 `scheme === 'colab'` 的 authority | `workspace.fs` 读 `colab://<id>/content/.colabdeck/metrics.jsonl` | 用户先打开名称匹配的官方终端；ColabDeck 只复用该终端 | Jupyter API 仅用于可选内核状态/工具 |
| **B. 未授权 / 无活动 kernel，但已挂载 server** | `workspace.workspaceFolders` 中 `scheme === 'colab'` 的 authority | 同上 | 用户先打开名称匹配的官方终端；ColabDeck 只复用该终端 | MVP 路径；无需授权 |
| **C. 曾经发现过 server** | 不自动恢复未挂载的旧 server；只使用当前 workspace 中仍挂载的 server | 同上 | 用户先打开名称匹配的官方终端；ColabDeck 只复用该终端 | 避免对已释放 runtime 或错误终端发命令 |
| **D. 无 server / 未登录 / 无权限** | — | — | — | 显示设置向导：打开 notebook、挂载 server、登录 Colab |
| **E. CPU/TPU runtime** | 同上 | 可采集 RAM/disk/CPU/温度 | 同上 | Idle Guard 进入 `UNSUPPORTED`，不误释放 |

补充：

- `label` 的来源：挂载模式用 `workspaceFolder.name`（官方 `server.label`）；Kernel API 模式官方没有公开 `server.label`，用 notebook 文件名代替，并在 UI 中显示“notebook 名”而不是假装是官方 label。
- `probeDir` 只允许 `/content/` 或 `/tmp/` 前缀，且只含 `[A-Za-z0-9._/-]`（不允许空格或 shell 元字符）；其他路径在 Host 与探针两侧都拒绝，避免误写系统目录或注入启动命令。
- 同一 server 有多个 kernel 时，优先 `vscode.window.activeNotebookEditor` 对应的 kernel；否则取 `last_activity` 最新的 kernel。不要假设只有一个 notebook。
- 挂载模式：官方 `colab.serverMounting` 默认 `false`，命令面板可能隐藏 `Colab: Mount Server to Workspace`；ColabDeck 的设置向导可直接 `executeCommand('colab.mountServer')`，或提示用户开启该配置。该命令本身不依赖这个配置，配置只影响菜单可见性。

### 1.7 现场验证关注点

1. `getActiveKernels()` 对 Colab kernel 确实返回 `serverProviderHandle.handle`，且与 `colab://` authority 一致。
2. `getKernel(uri).connection.serverSettings` 能被我们使用的 `@jupyterlab/services` 版本消费，并且能通过官方包装的 `fetch`/`WebSocket` 认证。
3. `workspace.fs` 在**没有挂载** workspace folder 时，仅凭 serverId 就能读写 `colab://<id>/content/...`。
4. 用户可通过官方 Colab 命令打开终端；ColabDeck 能通过 `name === server.label` 或 `name === server.id` 匹配已存在终端，`terminal.sendText` 能启动 detached 进程；ColabDeck 不负责终端生命周期。
5. `status.json` / `metrics.jsonl` 的读写、原子替换、半行处理都符合预期。
6. `nvidia-smi` 在 T4/L4/A100 上的查询格式；per-process memory 是否可用；不可用时 procfs 回退是否正确。
7. `colab.removeServer` 的 QuickPick 行为；确认后 workspace folder 被移除/FS 失效的时序。
8. ColabDeck 自身不产生任何 Google API 请求；探针不产生任何 Jupyter/WebSocket 连接。
9. 官方 `colab.consumptionStatusBar` 与我们的状态栏项不重叠、不冲突。
10. 非 trusted workspace / virtual workspace 下的行为与降级提示。

---

## 2. 目录结构规划

### 2.1 为什么用 npm workspaces 单仓

ColabDeck 有四个天然边界：

1. **Extension Host**：依赖 `vscode`、Node.js、文件系统、终端、状态栏。
2. **Shared Protocol**：纯 TypeScript 类型与纯函数，不依赖 `vscode` 或 DOM，必须能被 Extension 与 Webview 同时引用。
3. **Webview**：依赖 DOM、Preact、uPlot，不能依赖 `vscode`。
4. **Remote Probe**：独立 Python 脚本，零第三方运行时依赖，不能依赖 TS/Node。

用 npm workspaces 可以让每个包有独立的 `tsconfig`、依赖与构建产物，同时共享一个 lockfile 与 CI。对 MVP 来说不需要 Nx/Turbo。

### 2.2 目录树

```text
ColabDeck/
├─ package.json                     # workspaces + 根脚本
├─ package-lock.json
├─ tsconfig.base.json               # strict 基线
├─ tsconfig.json                    # project references
├─ eslint.config.js
├─ .prettierrc.json
├─ .gitignore
├─ README.md
├─ docs/
│  ├─ phase-1-architecture.md       # 本文
│  ├─ protocol.md                   # 协议细节
│  └─ mvp-validation.md             # 现场验证清单
├─ packages/
│  ├─ shared/                       # @colabdeck/shared（无 vscode/DOM 依赖）
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ protocol/
│  │     │  ├─ version.ts
│  │     │  ├─ probe.ts             # ProbeMessage / ProbeStatus / 命令与结果
│  │     │  └─ webview.ts           # WebviewToHost / HostToWebview / Snapshot
│  │     ├─ idleGuard/
│  │     │  ├─ states.ts
│  │     │  ├─ events.ts
│  │     │  ├─ transitions.ts       # 数据驱动的转换表
│  │     │  └─ reducer.ts           # 纯函数 reducer
│  │     ├─ ringBuffer.ts
│  │     ├─ format.ts                # formatBytes / gpuShortName / redact
│  │     └─ errors.ts
│  ├─ extension/                    # VS Code 扩展（workspace extension）
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ esbuild.mjs
│  │  ├─ src/
│  │  │  ├─ extension.ts            # activate/deactivate 与组合根
│  │  │  ├─ composition.ts          # 依赖注入/手动组装
│  │  │  ├─ config.ts
│  │  │  ├─ log.ts
│  │  │  ├─ server/
│  │  │  │  ├─ types.ts             # ServerDescriptor
│  │  │  │  ├─ serverRegistry.ts    # 合并三种发现源 + 去重 + 探活
│  │  │  │  ├─ kernelApiDiscovery.ts
│  │  │  │  ├─ mountedFolderDiscovery.ts
│  │  │  │  └─ persistedServerDiscovery.ts
│  │  │  ├─ jupyter/
│  │  │  │  ├─ api.ts               # ms-toolsai.jupyter 的最小类型化包装
│  │  │  │  └─ kernelClient.ts      # executeCode / shutdown（主内核动作）
│  │  │  ├─ probe/
│  │  │  │  ├─ probePaths.ts        # colab:// URI 构造与路径校验
│  │  │  │  ├─ probeInstaller.ts    # 写入 colabdeck_probe.py
│  │  │  │  ├─ probeLauncher.ts     # terminal / kernel 两种启动策略
│  │  │  │  ├─ probeReader.ts       # status.json + metrics.jsonl
│  │  │  │  ├─ probeCommands.ts     # 命令文件 RPC
│  │  │  │  └─ probeValidator.ts    # zod 校验
│  │  │  ├─ telemetry/
│  │  │  │  ├─ telemetryStore.ts   # per-server RingBuffer + summary
│  │  │  │  ├─ telemetrySampler.ts  # 5s 轮询、staleness、重试
│  │  │  │  └─ summary.ts
│  │  │  ├─ idleGuard/
│  │  │  │  ├─ idleGuardService.ts  # 状态机 + 定时器 + 通知
│  │  │  │  ├─ idleGuardTimers.ts
│  │  │  │  └─ release.ts          # 调用 colab.removeServer + 探活
│  │  │  ├─ toolbox/
│  │  │  │  ├─ processService.ts    # 列表/确认/kill
│  │  │  │  ├─ cudaCacheService.ts  # 主内核 empty_cache
│  │  │  │  └─ diskScanService.ts
│  │  │  ├─ statusbar/
│  │  │  │  └─ statusBarController.ts
│  │  │  ├─ webview/
│  │  │  │  ├─ dashboardProvider.ts
│  │  │  │  ├─ dashboardMessenger.ts
│  │  │  │  └─ html.ts
│  │  │  └─ commands/
│  │  │     └─ index.ts
│  │  └─ resources/
│  │     ├─ icon.png
│  │     └─ probe/
│  │        └─ colabdeck_probe.py   # 构建时从 packages/probe 复制
│  ├─ webview/                      # @colabdeck/webview
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ vite.config.ts
│  │  ├─ index.html
│  │  └─ src/
│  │     ├─ main.tsx
│  │     ├─ App.tsx
│  │     ├─ protocol.ts
│  │     ├─ hooks/
│  │     │  ├─ useHostMessenger.ts
│  │     │  └─ useTelemetry.ts
│  │     ├─ components/
│  │     │  ├─ Header.tsx
│  │     │  ├─ GpuCard.tsx
│  │     │  ├─ MetricChart.tsx
│  │     │  ├─ IdleGuardCard.tsx
│  │     │  ├─ ProcessTable.tsx
│  │     │  ├─ DiskScanPanel.tsx
│  │     │  └─ ErrorBanner.tsx
│  │     └─ styles.css
│  └─ probe/                        # 独立 Python 包
│     ├─ pyproject.toml
│     ├─ colabdeck_probe.py
│     └─ tests/
│        ├─ test_probe.py
│        ├─ test_commands.py
│        └─ fake_nvidia_smi.py
└─ tests/
   ├─ shared/
   └─ e2e/
```

### 2.3 依赖方向

```text
@colabdeck/shared   <── colabdeck (packages/extension)
       ↑
       └────────── @colabdeck/webview

packages/probe      独立运行，构建时复制到 extension/resources/probe
```

硬性规则：

- `shared` 不得 import `vscode`、Node 内置模块或 DOM。
- `webview` 不得 import `vscode` 或 Node 内置模块。
- `extension` 不得 import `webview` 的构建产物，只能加载 HTML/JS 资源。
- `probe` 不得 import Jupyter、requests、websocket、torch 等运行时依赖；只用标准库。

### 2.4 构建与打包

| 产物 | 工具 | 入口 | 输出 |
| --- | --- | --- | --- |
| shared 类型/纯函数 | `tsc -b` | `packages/shared/src/index.ts` | `packages/shared/dist` |
| extension | `esbuild` | `packages/extension/src/extension.ts` | `packages/extension/dist/extension.js` |
| webview | `vite` | `packages/webview/index.html` | `packages/extension/dist/webview` |
| probe | 复制 | `packages/probe/colabdeck_probe.py` | `packages/extension/resources/probe/colabdeck_probe.py` |
| VSIX | `@vscode/vsce` | `packages/extension/package.json` | `colabdeck-<version>.vsix` |

根脚本建议：

```json
{
  "scripts": {
    "build": "npm run build -w @colabdeck/shared && npm run build -w @colabdeck/webview && npm run build -w colabdeck && npm run sync:probe",
    "watch": "concurrently -n shared,webview,extension \"npm:watch:*\"",
    "test": "npm run build -w @colabdeck/shared && npm run test -w @colabdeck/shared && npm run test -w colabdeck && python3 -m pytest packages/probe -q",
    "lint": "eslint . && cd packages/probe && ruff check . && mypy .",
    "package": "npm run build && cd packages/extension && vsce package"
  }
}
```

### 2.5 TypeScript strict 基线

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true
  }
}
```

- `extension` 使用 `@types/vscode` 1.99.3 与 `@types/node` 22。
- `webview` 使用 `lib: ["ES2022", "DOM"]`，不引入 Node 类型。
- `shared` 使用 `lib: ["ES2022"]`，确保可被两端消费。
- 所有协议类型使用 `readonly` 与字面量联合；运行时边界用 `zod` 校验。

### 2.6 Extension manifest 要点

```jsonc
{
  "name": "colabdeck",
  "displayName": "ColabDeck",
  "publisher": "NanamiKite",
  "version": "0.1.0",
  "engines": { "vscode": "^1.99.3" },
  "extensionDependencies": ["google.colab", "ms-toolsai.jupyter"],
  "extensionKind": ["workspace"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": false,
      "description": "ColabDeck reads remote files and starts a probe; it requires a trusted workspace."
    },
    "virtualWorkspaces": {
      "supported": false,
      "description": "ColabDeck needs the colab:// file system and terminal; virtual workspaces are not supported."
    }
  },
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "colabdeck", "title": "ColabDeck", "icon": "resources/icon.png" }
      ]
    },
    "views": {
      "colabdeck": [
        { "id": "colabdeck.dashboard", "name": "Dashboard", "type": "webview" }
      ]
    },
    "commands": [
      { "command": "colabdeck.openDashboard", "title": "ColabDeck: Open Dashboard" },
      { "command": "colabdeck.refresh", "title": "ColabDeck: Refresh", "icon": "$(refresh)" },
      { "command": "colabdeck.stopMonitoring", "title": "ColabDeck: Stop Monitoring" },
      { "command": "colabdeck.startMonitoring", "title": "ColabDeck: Start Monitoring" },
      { "command": "colabdeck.restartProbe", "title": "ColabDeck: Restart Monitoring" },
      { "command": "colabdeck.openProbeLog", "title": "ColabDeck: View Diagnostics" },
      { "command": "colabdeck.showServerInfo", "title": "ColabDeck: Show Server Info" },
      { "command": "colabdeck.idleGuard.cancel", "title": "ColabDeck: Cancel Idle Countdown" },
      { "command": "colabdeck.idleGuard.snooze", "title": "ColabDeck: Snooze Idle Guard" },
      { "command": "colabdeck.idleGuard.releaseNow", "title": "ColabDeck: Release Colab Server Now" },
      { "command": "colabdeck.toolkit.killProcess", "title": "ColabDeck: Kill GPU Process..." },
      { "command": "colabdeck.toolkit.clearCudaCache", "title": "ColabDeck: Clear CUDA Cache" },
      { "command": "colabdeck.toolkit.scanDisk", "title": "ColabDeck: Scan Disk..." }
    ]
  }
}
```

说明：

- `extensionDependencies` 保证官方 Colab 与 Jupyter 扩展已安装；运行时仍要显式 `activate()` 后再使用 `colab://` / Kernel API。
- `activationEvents: ["onStartupFinished"]` 让状态栏在每个窗口常驻；代价是每次启动都会激活。若希望更轻量，可改为 `onNotebook:jupyter-notebook` + `onCommand:colabdeck.openDashboard`，但非 notebook 窗口不会显示状态栏。
- 状态栏项用 `window.createStatusBarItem({ id: 'colabdeck.statusBar', alignment: StatusBarAlignment.Right, priority: 10 })` 创建，避免与官方 `colab.consumptionStatusBar`（Right，默认 priority）冲突。
- `untrustedWorkspaces` / `virtualWorkspaces` 都设为 `false`：我们需要 `colab://` 文件系统、终端与 Kernel API，这些在非 trusted/virtual 场景下不可靠。
- `views` 的 `type: "webview"` 配合 `registerWebviewViewProvider('colabdeck.dashboard', ...)`；点击状态栏执行 `colabdeck.dashboard.focus`。

---

## 3. 核心契约定义

### 3.1 探针回传的 JSON Schema

#### 3.1.1 传输约定

探针与 Extension Host 之间不直接通信，而是通过 Colab runtime 上的文件交换：

```text
/content/.colabdeck/
├─ colabdeck_probe.py       # 扩展写入的探针脚本
├─ status.json              # 探针每个采样周期原子覆盖
├─ metrics.jsonl            # 追加写入，一行一个 JSON 对象
├─ metrics.1.jsonl          # 轮转后的上一份
├─ probe.log                # nohup 重定向的 stdout/stderr
├─ probe.lock               # fcntl 单实例锁
├─ commands/                # Host 写入，探针消费后删除
│  └─ <requestId>.json
└─ results/                 # 探针写入，Host 读取
   └─ <requestId>.json
```

硬性约定：

- 编码：UTF-8。
- `metrics.jsonl`：**NDJSON**，一行一个对象，以 `\n` 结尾；不美化、不压缩。
- 每条消息都有 `type` 与 `protocol`；`protocol = 1`。
- `seq` 在单个探针进程内单调递增；探针重启后重新从 1 开始，并更换 `bootId`。
- `bootId`：探针启动时生成的 UUID；`vmBootId`：读取 `/proc/sys/kernel/random/boot_id`。
- 时间戳：`timestampMs` 为 **Colab runtime 的 epoch 毫秒**；Extension Host 额外记录本地 `receivedAtMs`。图表用远端时间，staleness 用本地接收时间，避免时钟偏移误判。
- 所有“不可用”字段用 `null`，**不使用 `undefined`**，保证 JSON 形状稳定。
- 读取方只解析到最后一个完整 `\n` 为止；半行留到下一次读取。
- 探针只使用 Python 标准库；不 import Jupyter、requests、websocket、torch；不建立任何网络连接。

#### 3.1.2 TypeScript 类型（`packages/shared/src/protocol/probe.ts`）

```ts
export const PROBE_PROTOCOL_VERSION = 1 as const;

export type ProbeCapability =
  | 'gpu.query'
  | 'gpu.processes'
  | 'ram.procfs'
  | 'disk.statvfs'
  | 'cpu.loadavg'
  | 'temperature.thermal'
  | 'command.kill'
  | 'command.diskScan'
  | 'command.stop';

export interface ProbeHello {
  readonly type: 'HELLO';
  readonly protocol: 1;
  readonly bootId: string;
  readonly vmBootId: string;
  readonly pid: number;
  readonly python: string;
  readonly startedAtMs: number;
  readonly sampleIntervalMs: number;
  readonly probeDir: string;
  readonly metricsFile: string;
  readonly capabilities: readonly ProbeCapability[];
}

export interface ProbeSample {
  readonly type: 'SAMPLE';
  readonly protocol: 1;
  readonly bootId: string;
  readonly seq: number;
  readonly timestampMs: number;
  readonly intervalMs: number;
  readonly metrics: ProbeMetrics;
  readonly errors: readonly ProbeError[];
}

export interface ProbeMetrics {
  readonly gpu: GpuGroup;
  readonly ram: RamMetrics;
  readonly swap: SwapMetrics | null;
  readonly disk: DiskMetrics;
  readonly cpu: CpuMetrics;
  readonly temperature: TemperatureMetrics;
}

export interface GpuGroup {
  /** false 表示当前 runtime 没有 GPU，或从未成功探测到 GPU。 */
  readonly present: boolean;
  /** 指标来源；none 时 gpus 与 processes 为空。 */
  readonly source: 'nvidia-smi' | 'procfs' | 'none';
  readonly gpus: readonly GpuMetrics[];
  readonly processes: readonly GpuProcess[];
}

export interface GpuMetrics {
  readonly index: number;
  readonly name: string;
  readonly utilizationPct: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryTotalBytes: number | null;
  /** 探针启动以来的峰值，不是窗口峰值。 */
  readonly memoryPeakBytes: number | null;
  readonly temperatureC: number | null;
  readonly powerWatts: number | null;
}

export interface GpuProcess {
  readonly pid: number;
  readonly name: string;
  readonly command: string | null;
  readonly usedMemoryBytes: number | null;
  readonly gpuUuid: string | null;
}

export interface RamMetrics {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedBytes: number;
  readonly source: 'procfs' | 'psutil';
}

export interface SwapMetrics {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

export interface DiskMetrics {
  readonly path: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedBytes: number;
  readonly source: 'statvfs';
}

export interface CpuMetrics {
  readonly count: number;
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
}

export interface TemperatureMetrics {
  readonly cpuC: number | null;
  readonly gpuC: number | null;
  readonly source: 'thermal_zone' | 'hwmon' | 'nvidia-smi' | 'none';
}

export interface ProbeError {
  readonly metric: 'gpu' | 'gpu.processes' | 'ram' | 'swap' | 'disk' | 'cpu' | 'temperature';
  readonly message: string;
  readonly recoverable: boolean;
}

export interface ProbeCommandResult {
  readonly type: 'COMMAND_RESULT';
  readonly protocol: 1;
  readonly bootId: string;
  readonly requestId: string;
  readonly ok: boolean;
  readonly result: ProbeCommandResultPayload | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface ProbeBye {
  readonly type: 'BYE';
  readonly protocol: 1;
  readonly bootId: string;
  readonly reason: 'stop' | 'signal' | 'error';
  readonly message: string | null;
}

export type ProbeMessage =
  | ProbeHello
  | ProbeSample
  | ProbeCommandResult
  | ProbeBye;
```

`status.json`（探针每个采样周期原子覆盖）：

```ts
export interface ProbeStatus {
  readonly protocol: 1;
  readonly bootId: string;
  readonly vmBootId: string;
  readonly pid: number;
  readonly python: string;
  readonly startedAtMs: number;
  readonly serverNowMs: number;
  readonly lastSampleAtMs: number;
  readonly seq: number;
  readonly sampleIntervalMs: number;
  readonly probeDir: string;
  /** 仅文件名，例如 "metrics.jsonl"；Host 用它拼 colab:// URI。 */
  readonly metricsFile: string;
  readonly state: 'running' | 'stopping' | 'error';
  readonly capabilities: readonly ProbeCapability[];
}
```

命令文件（Host → 探针）：

```ts
export type ProbeCommand =
  | {
      readonly type: 'LIST_GPU_PROCESSES';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
    }
  | {
      readonly type: 'KILL_PROCESS';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
      readonly pid: number;
    }
  | {
      readonly type: 'SCAN_DISK';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
      readonly path: string;
      readonly maxEntries: number;
      readonly maxDepth: number;
    }
  | {
      readonly type: 'GET_PROBE_STATUS';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
    }
  | {
      readonly type: 'STOP';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
    };
```

结果 payload（探针 → Host）：

```ts
export type ProbeCommandResultPayload =
  | {
      readonly kind: 'LIST_GPU_PROCESSES';
      readonly processes: readonly GpuProcess[];
      readonly source: 'nvidia-smi' | 'procfs' | 'none';
      readonly errors: readonly ProbeError[];
    }
  | {
      readonly kind: 'KILL_PROCESS';
      readonly pid: number;
      readonly killed: boolean;
      readonly alreadyDead: boolean;
      readonly verified: boolean;
    }
  | {
      readonly kind: 'SCAN_DISK';
      readonly path: string;
      readonly entries: readonly DiskEntry[];
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'GET_PROBE_STATUS';
      readonly status: ProbeStatus;
    }
  | {
      readonly kind: 'STOP';
    };

export interface DiskEntry {
  readonly path: string;
  readonly bytes: number;
  readonly kind: 'file' | 'directory';
}
```

#### 3.1.3 JSON Schema（生成自 TS 类型）

Schema 可由 `probe.ts` 生成并在构建时校验类型一致性。以下是核心形状（省略仅用于诊断的 `HELLO`/`BYE`）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://colabdeck.dev/schemas/probe-message.json",
  "title": "ColabDeckProbeMessage",
  "oneOf": [
    { "$ref": "#/$defs/sample" },
    { "$ref": "#/$defs/commandResult" }
  ],
  "$defs": {
    "nullableNumber": { "type": ["number", "null"] },
    "gpuProcess": {
      "type": "object",
      "additionalProperties": false,
      "required": ["pid", "name", "command", "usedMemoryBytes", "gpuUuid"],
      "properties": {
        "pid": { "type": "integer", "minimum": 1 },
        "name": { "type": "string" },
        "command": { "type": ["string", "null"] },
        "usedMemoryBytes": { "type": ["integer", "null"], "minimum": 0 },
        "gpuUuid": { "type": ["string", "null"] }
      }
    },
    "gpuMetrics": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "index", "name", "utilizationPct", "memoryUsedBytes",
        "memoryTotalBytes", "memoryPeakBytes", "temperatureC", "powerWatts"
      ],
      "properties": {
        "index": { "type": "integer", "minimum": 0 },
        "name": { "type": "string" },
        "utilizationPct": { "type": ["number", "null"], "minimum": 0, "maximum": 100 },
        "memoryUsedBytes": { "type": ["integer", "null"], "minimum": 0 },
        "memoryTotalBytes": { "type": ["integer", "null"], "minimum": 0 },
        "memoryPeakBytes": { "type": ["integer", "null"], "minimum": 0 },
        "temperatureC": { "type": ["number", "null"] },
        "powerWatts": { "type": ["number", "null"] }
      }
    },
    "gpuGroup": {
      "type": "object",
      "additionalProperties": false,
      "required": ["present", "source", "gpus", "processes"],
      "properties": {
        "present": { "type": "boolean" },
        "source": { "enum": ["nvidia-smi", "procfs", "none"] },
        "gpus": { "type": "array", "items": { "$ref": "#/$defs/gpuMetrics" } },
        "processes": { "type": "array", "items": { "$ref": "#/$defs/gpuProcess" } }
      }
    },
    "sample": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "type", "protocol", "bootId", "seq",
        "timestampMs", "intervalMs", "metrics", "errors"
      ],
      "properties": {
        "type": { "const": "SAMPLE" },
        "protocol": { "const": 1 },
        "bootId": { "type": "string", "minLength": 1 },
        "seq": { "type": "integer", "minimum": 1 },
        "timestampMs": { "type": "integer", "minimum": 0 },
        "intervalMs": { "type": "integer", "minimum": 1000, "maximum": 60000 },
        "metrics": {
          "type": "object",
          "additionalProperties": false,
          "required": ["gpu", "ram", "swap", "disk", "cpu", "temperature"],
          "properties": {
            "gpu": { "$ref": "#/$defs/gpuGroup" },
            "ram": {
              "type": "object",
              "additionalProperties": false,
              "required": ["totalBytes", "availableBytes", "usedBytes", "source"],
              "properties": {
                "totalBytes": { "type": "integer", "minimum": 0 },
                "availableBytes": { "type": "integer", "minimum": 0 },
                "usedBytes": { "type": "integer", "minimum": 0 },
                "source": { "enum": ["procfs", "psutil"] }
              }
            },
            "swap": {
              "oneOf": [
                { "type": "null" },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["totalBytes", "freeBytes"],
                  "properties": {
                    "totalBytes": { "type": "integer", "minimum": 0 },
                    "freeBytes": { "type": "integer", "minimum": 0 }
                  }
                }
              ]
            },
            "disk": {
              "type": "object",
              "additionalProperties": false,
              "required": ["path", "totalBytes", "freeBytes", "usedBytes", "source"],
              "properties": {
                "path": { "type": "string" },
                "totalBytes": { "type": "integer", "minimum": 0 },
                "freeBytes": { "type": "integer", "minimum": 0 },
                "usedBytes": { "type": "integer", "minimum": 0 },
                "source": { "const": "statvfs" }
              }
            },
            "cpu": {
              "type": "object",
              "additionalProperties": false,
              "required": ["count", "load1", "load5", "load15"],
              "properties": {
                "count": { "type": "integer", "minimum": 1 },
                "load1": { "type": "number", "minimum": 0 },
                "load5": { "type": "number", "minimum": 0 },
                "load15": { "type": "number", "minimum": 0 }
              }
            },
            "temperature": {
              "type": "object",
              "additionalProperties": false,
              "required": ["cpuC", "gpuC", "source"],
              "properties": {
                "cpuC": { "$ref": "#/$defs/nullableNumber" },
                "gpuC": { "$ref": "#/$defs/nullableNumber" },
                "source": { "enum": ["thermal_zone", "hwmon", "nvidia-smi", "none"] }
              }
            }
          }
        },
        "errors": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["metric", "message", "recoverable"],
            "properties": {
              "metric": {
                "enum": ["gpu", "gpu.processes", "ram", "swap", "disk", "cpu", "temperature"]
              },
              "message": { "type": "string" },
              "recoverable": { "type": "boolean" }
            }
          }
        }
      }
    },
    "commandResult": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "protocol", "bootId", "requestId", "ok", "result", "error"],
      "properties": {
        "type": { "const": "COMMAND_RESULT" },
        "protocol": { "const": 1 },
        "bootId": { "type": "string" },
        "requestId": { "type": "string", "minLength": 1 },
        "ok": { "type": "boolean" },
        "result": { "type": ["object", "null"] },
        "error": {
          "oneOf": [
            { "type": "null" },
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["code", "message"],
              "properties": {
                "code": { "type": "string" },
                "message": { "type": "string" }
              }
            }
          ]
        }
      }
    }
  }
}
```

#### 3.1.4 `status.json` 的作用

`metrics.jsonl` 只追加，重启后会被截断；因此不能依赖文件最后一行来判断探针是否活着。`status.json` 是探针的健康快照：

- 探针每个采样周期 `write tmp + os.replace` 原子覆盖。
- Host 先读 `status.json`，再决定是否读 `metrics.jsonl`。
- `seq` 不再增长（Host 本地时间超过 `staleSampleMs`）→ 标记 `STALE`。
- `bootId` 改变或 `metricsFile` 改变 → 清空 RingBuffer 并从新文件开始。
- `state === 'stopping'` → 不再拉取。

#### 3.1.5 命令文件协议

1. Host 生成 UUID `requestId`，把 `ProbeCommand` 写成 `commands/<requestId>.json.tmp`，再 `workspace.fs.rename` 为 `commands/<requestId>.json`。
2. 探针每 500ms 扫描 `commands/*.json`；读取后校验 `protocol`、`type`、`requestId`、`issuedAtMs`。
3. 校验通过后执行固定 allowlist 的动作；结果写到 `results/<requestId>.json.tmp` 再 `os.replace`。
4. 探针删除命令文件；Host 读取结果后删除结果文件（或由探针定期清理）。
5. 超过 5 分钟的命令一律拒绝并删除，避免“迟到的 kill”。
6. 未知 `type`、未知字段、非法路径、非法 PID → 写回 `ok=false`，不执行。
7. 探针保留最近 100 个 `requestId` 的结果；重复 `requestId` 直接返回缓存结果，不重复执行。
8. 重试使用新的 `requestId`；`KILL_PROCESS` / `STOP` 幂等，`SCAN_DISK` 只读。

补充约束：

- `KILL_PROCESS` 只允许杀死**最近一次 GPU 进程列表**中的 PID；拒绝 `pid <= 1`、自身 PID、父 PID；执行前写审计日志。
- `KILL_PROCESS` 执行前重新查询一次 GPU 进程列表，确认 PID 仍在；否则返回 `alreadyDead=true` / `verified=false`，不盲目 `kill -9`。
- `issuedAtMs` 是 Host 本地时间。若 Host 与 Colab 时钟偏差较大，Host 可用 `status.serverNowMs` 与本地接收时间估算偏移后再写入；探针以 5 分钟为硬拒绝窗口。
- `SCAN_DISK` 的 `path` 必须是绝对路径，且 `realpath` 后位于 `/content` 或 `/tmp`；拒绝 `/proc`、`/sys`、`/dev`、`/etc`。

#### 3.1.6 采样内容与降级

| 指标 | 主来源 | 回退 | 备注 |
| --- | --- | --- | --- |
| GPU 名称/利用率/显存/温度/功耗 | `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits` | 无 → `gpus=[]`、`source='none'`、`errors` 记录 | 每次 2s 超时；不使用 `nvidia-smi -l` |
| GPU 进程 | `nvidia-smi --query-compute-apps=pid,process_name,used_memory,gpu_uuid --format=csv,noheader,nounits` | 扫描 `/proc/*/fd` 找 `/dev/nvidia*`，`usedMemoryBytes=null`，`source='procfs'` | 排除 PID 1、自身 PID、父 PID、`nvidia-smi` 子进程 |
| RAM | `/proc/meminfo` 的 `MemTotal`/`MemAvailable` | `psutil`（可选） | `used = total - available` |
| Swap | `/proc/meminfo` 的 `SwapTotal`/`SwapFree` | 无 → `null` | Colab 通常为 0 |
| 磁盘 | `os.statvfs(probeDir)` | 无 → 记录 error | 路径固定为探针目录所在卷 |
| CPU load | `os.getloadavg()` | 无 → 记录 error | 不计算 CPU 百分比，避免两次采样 |
| CPU 温度 | `/sys/class/thermal/thermal_zone*/temp`、`/sys/class/hwmon/hwmon*/temp1_input` | 无 → `null` | 取第一个合理值（0–150°C） |
| GPU 温度 | `nvidia-smi` 的 `temperature.gpu` | 无 → `null` | 多 GPU 取最大值给 `gpuC` |

> `memoryPeakBytes` 是探针**自启动以来**的峰值；UI 的“30 分钟窗口峰值”由 Host 的 RingBuffer 另行计算。两者不要混用。

> `nvidia-smi` 的 query 字段在不同驱动/Colab 镜像上可能有差异：先尝试带 `gpu_uuid` 的完整查询；失败则退化为 `pid,process_name,used_memory`；再失败才用 procfs。

探针行为约束：

- 启动时 `os.nice(10)`（失败则忽略），降低对训练的影响。
- 启动命令优先 `setsid`（如果可用），否则 `nohup`；确保探针脱离终端会话，终端关闭后仍存活。
- 每个指标独立 `try/except`；单个指标失败不影响整条样本。
- 不 import Jupyter/torch；不调用任何网络 API；不执行用户提供的任意 shell 字符串。
- 探针**不是心跳**：它不连接 Jupyter，也不阻止 Colab 的 90 分钟闲置回收；runtime 被回收时探针随之消失，Host 检测 stale 并等待重连。
- 探针以 Python 3.10 为基线；不使用 3.11+ only 语法，确保 Colab 的 3.10/3.11/3.12 镜像都能运行。
- 进程 `command` 截断到 200 字符，并在写入 `metrics.jsonl` 前先 redact `--token`/`--api-key`/`--password`/`key=`/`token=` 等模式；Host 在展示/日志前再次 redact。
- 单实例锁 `fcntl.flock(probe.lock)`；重复启动直接退出。
- 收到 `SIGTERM`/`SIGINT` 时写 `BYE`、删 PID、退出。
- `metrics.jsonl` 超过 2 MB 时轮转为 `metrics.1.jsonl`，`status.metricsFile` 指向新文件；Host 据此重置。

---

### 3.2 Extension Host ↔ Webview 的双向 `postMessage` 协议

#### 3.2.1 版本与握手

```ts
export const WEBVIEW_PROTOCOL_VERSION = 1 as const;
```

握手流程：

```text
Webview                         Extension Host
  |-- READY { protocol: 1 } ------->|
  |                                  |-- validate protocol
  |<-- SNAPSHOT + TELEMETRY_BATCH ---|
  |<-- IDLE_GUARD_STATE -------------|
  |<-- SETTINGS_CHANGED -------------|
```

- Webview 在 `resolveWebviewView` 后发送 `READY`。
- Host 校验 `protocol === WEBVIEW_PROTOCOL_VERSION`；不匹配则只发送 `PROTOCOL_MISMATCH`，不发送业务数据。
- Webview 收到 `PROTOCOL_MISMATCH` 后显示“请重新加载窗口”。
- Host 对所有入站消息用 `zod` 做 runtime 校验；未知 `type` 直接丢弃并记录日志。
- Webview 不信任任何业务数据之外的字段；所有消息都是 `readonly` 字面量联合。

#### 3.2.2 Webview → Host

```ts
export type TimeRange = '15m' | '30m' | '1h';

export type WebviewToHostMessage =
  | { readonly type: 'READY'; readonly protocol: 1 }
  | {
      readonly type: 'REQUEST_SNAPSHOT';
      readonly requestId: string;
      readonly range: TimeRange;
    }
  | {
      readonly type: 'SELECT_SERVER';
      readonly serverId: string;
    }
  | {
      readonly type: 'IDLE_GUARD_CANCEL';
      readonly requestId: string;
      readonly source: 'webview';
    }
  | {
      readonly type: 'IDLE_GUARD_SNOOZE';
      readonly requestId: string;
      readonly durationMs: number;
      readonly source: 'webview';
    }
  | {
      readonly type: 'IDLE_GUARD_RELEASE_NOW';
      readonly requestId: string;
      readonly source: 'webview';
    }
  | {
      readonly type: 'IDLE_GUARD_SET_ENABLED';
      readonly enabled: boolean;
    }
  | {
      readonly type: 'REFRESH_GPU_PROCESSES';
      readonly requestId: string;
    }
  | {
      readonly type: 'KILL_PROCESS';
      readonly requestId: string;
      readonly pid: number;
    }
  | {
      readonly type: 'CLEAR_CUDA_CACHE';
      readonly requestId: string;
    }
  | {
      readonly type: 'SCAN_DISK';
      readonly requestId: string;
      readonly path: string;
      readonly maxEntries: number;
      readonly maxDepth: number;
    }
  | {
      readonly type: 'DISMISS_ERROR';
      readonly errorId: string;
    }
  | { readonly type: 'MOUNT_COLAB_SERVER' }
  | { readonly type: 'RELOAD_WINDOW' }
  | { readonly type: 'OPEN_SETTINGS' }
  | { readonly type: 'OPEN_PROBE_LOG' }
  | { readonly type: 'RETRY_PROBE' };
```

#### 3.2.3 Host → Webview

```ts
export type HostToWebviewMessage =
  | {
      readonly type: 'PROTOCOL_MISMATCH';
      readonly hostProtocol: 1;
      readonly webviewProtocol: number;
    }
  | {
      readonly type: 'SNAPSHOT';
      readonly snapshot: DashboardSnapshot;
    }
  | {
      readonly type: 'TELEMETRY_BATCH';
      readonly range: TimeRange;
      readonly samples: readonly TelemetrySample[];
    }
  | {
      readonly type: 'TELEMETRY_APPEND';
      readonly sample: TelemetrySample;
    }
  | {
      readonly type: 'IDLE_GUARD_STATE';
      readonly state: IdleGuardView;
      readonly countdown: CountdownView | null;
      readonly recentTransitions: readonly IdleGuardTransitionView[];
    }
  | {
      readonly type: 'GPU_PROCESSES';
      readonly processes: readonly GpuProcessView[];
      readonly source: 'nvidia-smi' | 'procfs' | 'none';
      readonly fetchedAtMs: number;
      readonly warning: string | null;
    }
  | {
      readonly type: 'TOOLBOX_RESULT';
      readonly requestId: string;
      readonly result: ToolboxResult;
    }
  | {
      readonly type: 'ERROR';
      readonly errorId: string;
      readonly message: string;
      readonly detail: string | null;
      readonly recoverable: boolean;
      readonly action: 'RETRY' | 'OPEN_SETTINGS' | 'OPEN_PROBE_LOG' | 'NONE';
    }
  | {
      readonly type: 'SETTINGS_CHANGED';
      readonly settings: DashboardSettings;
    };
```

#### 3.2.4 Snapshot 与遥测视图

```ts
export interface ServerDescriptor {
  /** colab:// 的 authority；不透明，不是 token。 */
  readonly id: string;
  readonly label: string;
  readonly source: 'kernel-api' | 'mounted-folder' | 'persisted';
  readonly notebookUri: string | null;
  /** 仅用于日志/诊断；不要发到 Webview。 */
  readonly jupyterBaseUrl: string | null;
  readonly kernelApiAvailable: boolean;
}

export interface DashboardSnapshot {
  readonly protocol: 1;
  readonly generatedAtMs: number;
  readonly servers: readonly ServerView[];
  readonly selectedServerId: string | null;
  readonly connection: 'disconnected' | 'syncing' | 'connected' | 'stale' | 'error';
  readonly probe: ProbeView | null;
  readonly latest: TelemetrySample | null;
  readonly idleGuard: IdleGuardView;
  readonly countdown: CountdownView | null;
  readonly errors: readonly UiError[];
  readonly settings: DashboardSettings;
}

export interface ServerView {
  readonly id: string;
  readonly label: string;
  readonly source: 'kernel-api' | 'mounted-folder' | 'persisted';
  readonly notebookUri: string | null;
}

export interface ProbeView {
  readonly pid: number;
  readonly bootId: string;
  readonly startedAtMs: number;
  readonly lastSampleAtMs: number;
  readonly lastReceivedAtMs: number;
  readonly sampleIntervalMs: number;
  readonly status: 'starting' | 'running' | 'stale' | 'stopped' | 'error';
}

export interface TelemetrySample {
  readonly seq: number;
  readonly timestampMs: number;
  readonly receivedAtMs: number;
  readonly gpus: readonly GpuSample[];
  readonly gpuAggregate: GpuAggregate | null;
  readonly ram: RamSample;
  readonly disk: DiskSample;
  readonly cpu: CpuSample;
  readonly temperature: TemperatureSample;
  readonly errors: readonly string[];
}

export interface GpuSample {
  readonly index: number;
  readonly name: string;
  readonly utilizationPct: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryTotalBytes: number | null;
  readonly temperatureC: number | null;
  readonly powerWatts: number | null;
}

export interface GpuAggregate {
  readonly count: number;
  readonly shortName: string;
  /** 多 GPU 取最大值：只要有一张卡忙，就不算 idle。 */
  readonly utilizationPct: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryTotalBytes: number | null;
  readonly temperatureC: number | null;
  readonly powerWatts: number | null;
}

// shortName 映射建议：
// "Tesla T4" -> "T4"
// "NVIDIA A100-SXM4-40GB" -> "A100"
// "Tesla V100-SXM2-16GB" -> "V100"
// "NVIDIA L4" -> "L4"
// 多 GPU -> "2x T4"

export interface RamSample {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedBytes: number;
}

export interface DiskSample {
  readonly path: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedBytes: number;
}

export interface CpuSample {
  readonly count: number;
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
}

export interface TemperatureSample {
  readonly cpuC: number | null;
  readonly gpuC: number | null;
}

export interface IdleGuardView {
  readonly status: IdleGuardStatus;
  readonly enabled: boolean;
  readonly thresholdPct: number;
  readonly idleForMs: number;
  readonly idleThresholdMs: number;
  readonly snoozedUntilMs: number | null;
  readonly lastTransitionAtMs: number;
  readonly reason: string | null;
  readonly kernelBusy: boolean | null;
}

export interface CountdownView {
  readonly endsAtMs: number;
  readonly remainingMs: number;
  readonly autoRelease: boolean;
  readonly phase: 'warning' | 'expired' | 'kernel-busy' | 'terminating';
}

export interface IdleGuardTransitionView {
  readonly atMs: number;
  readonly from: IdleGuardStatus;
  readonly to: IdleGuardStatus;
  readonly event: string;
  readonly reason: string;
}

export interface UiError {
  readonly id: string;
  readonly message: string;
  readonly detail: string | null;
  readonly recoverable: boolean;
  readonly action: 'RETRY' | 'OPEN_SETTINGS' | 'OPEN_PROBE_LOG' | 'NONE';
}

export interface DashboardSettings {
  readonly timeRange: TimeRange;
  readonly idleGuard: {
    readonly enabled: boolean;
    readonly thresholdPct: number;
    readonly idleThresholdMinutes: number;
    readonly countdownSeconds: number;
    readonly autoRelease: boolean;
    readonly requireKernelIdle: 'auto' | 'always' | 'never';
  };
  readonly probe: {
    readonly sampleIntervalMs: number;
  };
}

export type ToolboxResult =
  | {
      readonly kind: 'KILL_PROCESS';
      readonly ok: boolean;
      readonly pid: number;
      readonly alreadyDead: boolean;
      readonly verified: boolean;
      readonly message: string | null;
    }
  | {
      readonly kind: 'SCAN_DISK';
      readonly ok: boolean;
      readonly path: string;
      readonly entries: readonly DiskEntry[];
      readonly truncated: boolean;
      readonly message: string | null;
    }
  | {
      readonly kind: 'CLEAR_CUDA_CACHE';
      readonly ok: boolean;
      readonly message: string;
    }
  | {
      readonly kind: 'REFRESH_PROCESSES';
      readonly ok: boolean;
      readonly message: string | null;
    };

export interface GpuProcessView {
  readonly pid: number;
  readonly name: string;
  readonly command: string | null;
  readonly usedMemoryBytes: number | null;
  readonly gpuUuid: string | null;
}
```

#### 3.2.5 消息频率与背压

| 消息 | 频率 | 说明 |
| --- | --- | --- |
| `SNAPSHOT` | `READY`、server 切换、错误变化、可见性恢复 | 只含最新样本与状态，不含历史 |
| `TELEMETRY_BATCH` | `READY`、`REQUEST_SNAPSHOT`、Webview 从隐藏恢复可见 | 最多 1h；>600 点时按 bucket 下采样 |
| `TELEMETRY_APPEND` | 每个新样本（默认 5s） | 单样本；Webview 自行按 `timestampMs` 去重 |
| `IDLE_GUARD_STATE` | 每次转换 + 倒计时每 1s | 非倒计时阶段不发送 |
| `GPU_PROCESSES` | 打开 Toolbox 时、手动刷新、每 10s（仅可见） | 不自动高频轮询 |
| `ERROR` | 错误发生时 | 同一 `errorId` 去重 |

规则：

- Webview 隐藏时 Host **继续采样**（状态栏与 Idle Guard 需要），但暂停向 Webview 推送；恢复可见时补发 `SNAPSHOT` + `TELEMETRY_BATCH`。
- Host 侧合并 1s 内的多次 `TELEMETRY_APPEND`，避免洪峰。
- Host 永不向 Webview 发送 token、headers、`serverSettings`、远端命令行明文（命令行先 redact）。
- RingBuffer 容量 = `ceil(1h / sampleIntervalMs)`，上限 3600；默认 5s → 720 条。
- 下采样按指标语义选择聚合方式：VRAM 用 `max`（保留峰值），利用率用 `avg`，温度用 `max`；不要对 VRAM 用 avg 抹掉峰值。

---

### 3.3 Idle Guard 状态机

#### 3.3.1 状态

```ts
export type IdleGuardStatus =
  | 'DISABLED'
  | 'DISCONNECTED'
  | 'SYNCING'
  | 'ACTIVE'
  | 'IDLE_DETECTED'
  | 'COUNTDOWN_WARNING'
  | 'TERMINATING'
  | 'TERMINATED'
  | 'ERROR'
  | 'UNSUPPORTED';
```

| 状态 | 含义 | UI 表现 |
| --- | --- | --- |
| `DISABLED` | 用户关闭 Idle Guard，或扩展未激活 | `Idle Guard: OFF` |
| `DISCONNECTED` | 没有 server / probe，或已释放 | `Idle Guard: --` |
| `SYNCING` | 已发现 server，等待第一条新鲜样本 | `Idle Guard: SYNC` |
| `ACTIVE` | GPU 达标，或处于宽限/ snooze | `Idle Guard: ON` |
| `IDLE_DETECTED` | GPU 连续低于阈值，正在累计 idle 时间 | `Idle Guard: 2m/5m` |
| `COUNTDOWN_WARNING` | 达到 idle 阈值，倒计时进行中/已过期 | `Idle Guard: 1:42` |
| `TERMINATING` | 已调用官方释放命令，等待用户确认/结果 | `Idle Guard: RELEASING` |
| `TERMINATED` | 释放成功 | `Idle Guard: RELEASED` |
| `ERROR` | 释放失败或不可恢复错误 | `Idle Guard: ERR` |
| `UNSUPPORTED` | CPU/TPU runtime，无 GPU | `Idle Guard: N/A` |

#### 3.3.2 设置、状态与事件

```ts
export interface IdleGuardSettings {
  readonly enabled: boolean;
  readonly gpuUtilizationThresholdPct: number;
  /** 连续低于阈值多久才进入 IDLE_DETECTED。 */
  readonly idleDebounceMs: number;
  /** 连续 idle 多久开始倒计时。 */
  readonly idleThresholdMs: number;
  readonly countdownMs: number;
  readonly staleSampleMs: number;
  /** 连接后的宽限期。 */
  readonly minRuntimeMs: number;
  readonly snoozeMs: number;
  readonly autoRelease: boolean;
  readonly requireKernelIdle: 'auto' | 'always' | 'never';
}

export type IdleGuardEvent =
  | { readonly type: 'SETTINGS_ENABLED' }
  | { readonly type: 'SETTINGS_DISABLED' }
  | { readonly type: 'SETTINGS_CHANGED'; readonly settings: IdleGuardSettings }
  | {
      readonly type: 'SERVER_CONNECTED';
      readonly serverId: string;
      readonly gpuPresent: boolean;
      readonly connectedAtMs: number;
    }
  | { readonly type: 'SERVER_DISCONNECTED'; readonly reason: string }
  | { readonly type: 'PROBE_STARTED' }
  | { readonly type: 'PROBE_LOST'; readonly reason: string }
  | { readonly type: 'PROBE_ERROR'; readonly message: string }
  | {
      readonly type: 'SAMPLE_RECEIVED';
      readonly sample: TelemetrySample;
      readonly sampleAgeMs: number;
      readonly kernelBusy: boolean | null;
    }
  | { readonly type: 'IDLE_THRESHOLD_REACHED' }
  | { readonly type: 'COUNTDOWN_TICK'; readonly remainingMs: number }
  | { readonly type: 'COUNTDOWN_EXPIRED' }
  | {
      readonly type: 'CANCEL';
      readonly source: 'webview' | 'notification' | 'command';
    }
  | {
      readonly type: 'SNOOZE';
      readonly durationMs: number;
      readonly source: 'webview' | 'notification' | 'command';
    }
  | {
      readonly type: 'RELEASE_NOW';
      readonly source: 'webview' | 'notification' | 'command';
    }
  | { readonly type: 'RELEASE_SUCCEEDED' }
  | { readonly type: 'RELEASE_FAILED'; readonly message: string }
  | { readonly type: 'RELEASE_CANCELLED'; readonly reason: string }
  | { readonly type: 'RETRY' };
```

Reducer 内部状态：

```ts
export interface IdleGuardState {
  readonly status: IdleGuardStatus;
  readonly serverId: string | null;
  readonly connectedAtMs: number | null;
  readonly lastActivityAtMs: number | null;
  /** 第一次连续低于阈值的时间；用于 idleFor。 */
  readonly idleSinceMs: number | null;
  readonly snoozedUntilMs: number | null;
  readonly countdownEndsAtMs: number | null;
  readonly lastSample: TelemetrySample | null;
  readonly lastSampleAgeMs: number | null;
  /** true=busy, false=idle, null=未知。 */
  readonly kernelBusy: boolean | null;
  readonly lastTransitionAtMs: number;
  readonly reason: string | null;
  /** 用于丢弃过期定时器回调。 */
  readonly generation: number;
}
```

#### 3.3.3 状态图

```text
                 SETTINGS_ENABLED
   DISABLED ───────────────────────────► DISCONNECTED
      ▲                                      │
      │ SETTINGS_DISABLED                    │ SERVER_CONNECTED
      │                                      ▼
      │                                   SYNCING
      │                                      │ SAMPLE_RECEIVED (fresh, GPU)
      │                                      ▼
      │              CANCEL/SNOOZE  ┌──────► ACTIVE ◄────────────┐
      │                            │           │                 │
      │                            │           │ GPU < threshold │ GPU >= threshold
      │                            │           ▼                 │
      │                            └──── IDLE_DETECTED ──────────┘
      │                                        │ IDLE_THRESHOLD_REACHED
      │                                        ▼
      │                               COUNTDOWN_WARNING
      │                                        │ COUNTDOWN_EXPIRED (autoRelease)
      │                                        ▼
      │                                   TERMINATING
      │                                    │           │
      │                    RELEASE_SUCCEEDED           RELEASE_FAILED
      │                                    ▼           ▼
      │                                 TERMINATED     ERROR
      │                                    │
      └──────────── SERVER_DISCONNECTED ───┘
```

#### 3.3.4 转换表

> `fresh` = `sampleAgeMs <= staleSampleMs`；`util` = 多 GPU 的最大利用率；`runtimeAge` = `now - connectedAtMs`；`lowFor` = 连续低于阈值的时长；`kernelBusy` = 主内核是否正在执行（未知为 `null`）。
>
> **匹配规则**：从上到下匹配，第一条满足 `From` 与 `Guard` 的行胜出；`any` 行只在没有更具体行匹配时生效。

| # | From | Event | Guard | To | Side effects |
| --- | --- | --- | --- | --- | --- |
| 1 | `DISABLED` | `SETTINGS_ENABLED` | — | `DISCONNECTED` | log, publish |
| 2 | `DISCONNECTED` | `SERVER_CONNECTED` | — | `SYNCING` | log, publish, ensure probe |
| 2a | `DISCONNECTED` | `PROBE_STARTED` | — | `SYNCING` | log, publish |
| 3 | `SYNCING` | `SAMPLE_RECEIVED` | `fresh && gpuPresent` | `ACTIVE` | set `lastActivityAt`, log, publish |
| 4 | `SYNCING` | `SAMPLE_RECEIVED` | `fresh && !gpuPresent` | `UNSUPPORTED` | log, publish |
| 5 | `SYNCING` | `PROBE_ERROR` / `PROBE_LOST` / `SERVER_DISCONNECTED` | — | `DISCONNECTED` | log, publish |
| 6 | `ACTIVE` | `SAMPLE_RECEIVED` | `fresh && util >= threshold` | `ACTIVE` | reset idle timer, publish |
| 7 | `ACTIVE` | `SAMPLE_RECEIVED` | `fresh && util < threshold && runtimeAge >= minRuntime && !snoozed && lowFor >= idleDebounce` | `IDLE_DETECTED` | start idle timer, log, publish |
| 8 | `ACTIVE` | `SAMPLE_RECEIVED` | `fresh && util < threshold && (runtimeAge < minRuntime \|\| snoozed)` | `ACTIVE` | debug log, publish |
| 9 | `ACTIVE` | `SAMPLE_RECEIVED` | `!fresh` | `DISCONNECTED` | cancel timers, log, publish |
| 10 | `ACTIVE` | `SERVER_DISCONNECTED` / `PROBE_LOST` / `PROBE_ERROR` | — | `DISCONNECTED` | cancel timers, log |
| 11 | `ACTIVE` | `SETTINGS_DISABLED` | — | `DISABLED` | cancel timers, publish |
| 12 | `IDLE_DETECTED` | `SAMPLE_RECEIVED` | `fresh && util >= threshold` | `ACTIVE` | cancel idle timer, reset, log |
| 13 | `IDLE_DETECTED` | `IDLE_THRESHOLD_REACHED` | — | `COUNTDOWN_WARNING` | start countdown, show notification, log |
| 14 | `IDLE_DETECTED` | `SAMPLE_RECEIVED` | `!fresh` | `DISCONNECTED` | cancel timers, log |
| 15 | `IDLE_DETECTED` | `SERVER_DISCONNECTED` / `PROBE_LOST` / `PROBE_ERROR` / `SETTINGS_DISABLED` | — | `DISCONNECTED` / `DISABLED` | cancel timers, publish |
| 16 | `COUNTDOWN_WARNING` | `SAMPLE_RECEIVED` | `fresh && util >= threshold` | `ACTIVE` | auto-cancel, reset idle, hide notification, log |
| 17 | `COUNTDOWN_WARNING` | `CANCEL` | — | `ACTIVE` | cancel countdown, reset idle, hide notification, log |
| 18 | `COUNTDOWN_WARNING` | `SNOOZE` | — | `ACTIVE` | set `snoozedUntilMs`, cancel countdown, log |
| 19 | `COUNTDOWN_WARNING` | `COUNTDOWN_EXPIRED` | `autoRelease && kernelBusy !== true` | `TERMINATING` | invoke release, log |
| 20 | `COUNTDOWN_WARNING` | `COUNTDOWN_EXPIRED` | `!autoRelease \|\| kernelBusy === true` | `COUNTDOWN_WARNING` | `phase='expired'` 或 `'kernel-busy'`；显示 “Release now”；log |
| 21 | `COUNTDOWN_WARNING` | `RELEASE_NOW` | — | `TERMINATING` | invoke release, log |
| 22 | `COUNTDOWN_WARNING` | `SAMPLE_RECEIVED` | `!fresh` | `DISCONNECTED` | cancel timers, hide notification, log |
| 23 | `COUNTDOWN_WARNING` | `SERVER_DISCONNECTED` / `PROBE_LOST` / `PROBE_ERROR` / `SETTINGS_DISABLED` | — | `DISCONNECTED` / `DISABLED` | cancel timers, hide notification |
| 23a | `TERMINATING` | `PROBE_LOST` / `SERVER_DISCONNECTED` / `PROBE_ERROR` / `stale` | — | `TERMINATING` | debug log；忽略，等待 release 结果 |
| 23b | `TERMINATING` | `SAMPLE_RECEIVED` / `COUNTDOWN_TICK` | — | `TERMINATING` | update last sample, publish |
| 24 | `TERMINATING` | `RELEASE_SUCCEEDED` | — | `TERMINATED` | log, publish, show success |
| 25 | `TERMINATING` | `RELEASE_FAILED` | — | `ERROR` | log, show error |
| 26 | `TERMINATING` | `RELEASE_CANCELLED` | — | `ACTIVE` | reset idle, log |
| 27 | `TERMINATING` | `SETTINGS_DISABLED` | — | `DISABLED` | log |
| 28 | `TERMINATED` | `SERVER_DISCONNECTED` | — | `DISCONNECTED` | log |
| 29 | `ERROR` | `RETRY` | — | `SYNCING` | log |
| 30 | `ERROR` | `SERVER_DISCONNECTED` | — | `DISCONNECTED` | log |
| 31 | `UNSUPPORTED` | `SAMPLE_RECEIVED` | `gpuPresent` | `ACTIVE` | log, publish |
| 32 | `UNSUPPORTED` | `SAMPLE_RECEIVED` | `!gpuPresent` | `UNSUPPORTED` | publish |
| 33 | any | `SETTINGS_DISABLED` | — | `DISABLED` | cancel timers, hide notifications, publish |
| 34 | any | `SERVER_DISCONNECTED` | — | `DISCONNECTED` | cancel timers, hide notifications, publish |
| 35 | any | `PROBE_LOST` / `PROBE_ERROR` | — | `DISCONNECTED` | cancel timers, log（**绝不释放**） |

补充规则：

- **`TERMINATING` 是吸收态**：在 `executeCommand('colab.removeServer')` 的 Promise resolve 之前，忽略 `PROBE_LOST` / `SERVER_DISCONNECTED` / `stale`，避免“释放过程中探针先死”把状态提前打成 `DISCONNECTED`。release 结果到达后统一走 `RELEASE_SUCCEEDED` / `RELEASE_CANCELLED` / `RELEASE_FAILED`。
- **重新启用时的重同步**：`SETTINGS_ENABLED` 时如果当前已有 server，Service 立即补发 `SERVER_CONNECTED`（或 reducer 直接进入 `SYNCING`），不要停在 `DISCONNECTED`。`SETTINGS_CHANGED` 不改变状态，只更新 settings 并触发一次 re-evaluation。
- **`TERMINATING` 期间关闭 Idle Guard 不会撤销已发出的 release 命令**；只能由用户在官方 QuickPick 中取消。
- **`DISABLED` 是吸收态**：除 `SETTINGS_ENABLED` / `SETTINGS_CHANGED` 外，忽略所有事件（包括 `PROBE_LOST`、`SERVER_DISCONNECTED`、`SAMPLE_RECEIVED`），避免关闭状态下被探针事件唤醒。
- **`TERMINATED` / `ERROR` 对 `SAMPLE_RECEIVED` 不做状态转换**，只更新缓存/日志；避免释放后又被样本拉回 `ACTIVE`。
- **状态不持久化**。扩展宿主重启后总是从 `DISABLED`/`DISCONNECTED` 开始；绝不恢复一个旧的 `COUNTDOWN_WARNING`。这是失效安全的核心。
- `IDLE_DETECTED` 表示“已经连续低于阈值，正在累计 idle 时间”；`COUNTDOWN_WARNING` 表示“累计时间达到 N 分钟，倒计时开始”。这样 UI 可以在 5 分钟内显示 `Idle for 2m/5m`，而不是一上来就倒计时。
- `COUNTDOWN_EXPIRED` 且 `autoRelease=false` 时停在 `COUNTDOWN_WARNING`，`phase='expired'`，提供 “Release now” 按钮；绝不自动调用释放命令。
- `kernelBusy === true` 时不自动释放，停在 `phase='kernel-busy'`；用户仍可手动 “Release now”。`kernelBusy === null`（无 Kernel API 权限）时按 GPU-only 逻辑处理，并在日志中标注 `kernelStatus=unknown`。
- 任何 `PROBE_LOST`/stale 都优先转 `DISCONNECTED`，绝不因为“读不到数据”而释放。

`requireKernelIdle` 的判定：

| 值 | 倒计时到期的释放 guard |
| --- | --- |
| `never` | `autoRelease` 即可，完全忽略 kernel 状态 |
| `always` | `autoRelease && kernelBusy === false`（未知也抑制） |
| `auto` | `autoRelease && kernelBusy !== true`（未知不抑制） |

#### 3.3.5 Effects（reducer 输出）

```ts
export type IdleGuardEffect =
  | { readonly type: 'LOG_TRANSITION'; readonly transition: IdleGuardTransition }
  | { readonly type: 'PUBLISH_STATE'; readonly state: IdleGuardView; readonly countdown: CountdownView | null }
  | { readonly type: 'START_IDLE_TIMER'; readonly delayMs: number; readonly generation: number }
  | { readonly type: 'CANCEL_IDLE_TIMER' }
  | { readonly type: 'START_COUNTDOWN'; readonly endsAtMs: number; readonly generation: number }
  | { readonly type: 'CANCEL_COUNTDOWN' }
  | { readonly type: 'SHOW_COUNTDOWN_NOTIFICATION'; readonly message: string; readonly actions: readonly CountdownAction[] }
  | { readonly type: 'HIDE_COUNTDOWN_NOTIFICATION' }
  | { readonly type: 'INVOKE_RELEASE'; readonly serverId: string }
  | { readonly type: 'SHOW_RELEASE_GUIDANCE'; readonly serverId: string }
  | { readonly type: 'SHOW_ERROR'; readonly code: string; readonly message: string; readonly recoverable: boolean }
  | { readonly type: 'RESET_IDLE_TIMER' }
  | { readonly type: 'SET_SNOOZE'; readonly untilMs: number }
  | { readonly type: 'NONE' };

export type CountdownAction = 'CANCEL' | 'SNOOZE' | 'RELEASE_NOW';
```

`reducer(state, event, context)` 是纯函数，不直接调用 `vscode`。`IdleGuardService` 负责：

- 把 `START_*` 转成 `setTimeout`/`setInterval`，并用 `generation` 丢弃过期回调。
- 把 `PUBLISH_STATE` 发给状态栏与 Webview。
- 把 `INVOKE_RELEASE` 转成 `executeCommand('colab.removeServer')`。
- 把 `SHOW_*` 转成 VS Code 通知/进度条。

这样状态机可以 100% 单元测试，不依赖 VS Code。

#### 3.3.6 日志与可观测性

每次转换输出一行结构化日志到 `ColabDeck` Output Channel：

```text
[2026-11-25T22:05:00.123Z] [IdleGuard] IDLE_DETECTED -> COUNTDOWN_WARNING
  server=abc12345 gpu=0.0% threshold=5.0% idleFor=300000ms
  countdown=120000ms sampleAge=120ms kernelBusy=false
  reason="GPU below threshold for 5m"
```

`IdleGuardTransition` 字段：

```ts
export interface IdleGuardTransition {
  readonly atMs: number;
  readonly from: IdleGuardStatus;
  readonly to: IdleGuardStatus;
  readonly event: IdleGuardEvent['type'];
  readonly reason: string;
  readonly serverId: string | null;
  readonly gpuUtilizationPct: number | null;
  readonly thresholdPct: number;
  readonly idleForMs: number;
  readonly countdownRemainingMs: number | null;
  readonly sampleAgeMs: number | null;
  readonly kernelBusy: boolean | null;
}
```

- Webview 的 Idle Guard 卡片显示最近 10 条转换。
- 状态栏 tooltip 显示最近一次转换与 `reason`。
- 所有日志不包含 token、headers、完整命令行；`serverId` 在 info 级别可缩写为前 8 位，debug 级别输出完整值。

#### 3.3.7 失效安全（fail-safe）

| 风险 | 处理 |
| --- | --- |
| 探针停止/崩溃 | `seq` 不增长 → `PROBE_LOST` → `DISCONNECTED`；取消所有计时器；绝不释放 |
| 采样延迟/时钟偏移 | staleness 用 Host 本地接收时间；图表用远端时间；两者不混用 |
| CPU/TPU runtime | `UNSUPPORTED`；不进入倒计时 |
| 训练刚启动/数据加载 | `minRuntimeMinutes` 宽限；`idleDebounceMs` 去抖；`kernelBusy` 可选抑制 |
| 用户正在交互 | Webview/通知/命令三处均可 Cancel；Cancel 重置 idle 计时 |
| 释放命令失败/不可用 | 转 `ERROR`；显示 “Open Colab extension” 与 “Retry”；绝不假装成功 |
| 释放命令交互式 | 明确提示用户在官方 QuickPick 中确认；不模拟按键 |
| 扩展宿主重启 | 不恢复倒计时；从 `DISCONNECTED` 重新评估 |
| 多服务器 | 只对当前选中的 server 触发；释放前再次校验 serverId 与 label |

#### 3.3.8 释放流程与官方限制

```text
COUNTDOWN_WARNING
  │ COUNTDOWN_EXPIRED / RELEASE_NOW
  ▼
TERMINATING
  │ await vscode.commands.executeCommand('colab.removeServer')
  │   └─ 官方选择对话框弹出
  │       ├─ 用户确认 → unassignServer → Promise resolve
  │       └─ 用户取消 → Promise resolve
  ▼
检测 server 是否还活着（workspace.fs.stat / getActiveKernels）
  ├─ 已消失 → RELEASE_SUCCEEDED → TERMINATED
  ├─ 仍存在 → RELEASE_CANCELLED → ACTIVE（重置 idle）
  └─ 命令 reject → RELEASE_FAILED → ERROR
```

**硬限制**：官方 `colab.removeServer` 没有参数化入口，且需要用户在对话框中选择和确认。我们可以在倒计时结束时调用它，但**不能安全地自动确认**。

明确拒绝的“自动化”手段：

- `workbench.action.acceptSelectedQuickOpenItem`：可能接受错误的 QuickPick；多服务器时可能释放错误 runtime；无法可靠确认当前 QuickPick 就是 Colab 的。**不采用**。
- 直接调用 `colabApiClient.deleteRuntime`：Google 私有 API，违反边界。**不采用**。
- 从 runtime 内部 `kill -9 1`：不是“释放”，可能留下脏状态。**不采用**。

推荐方案（待你确认）：

1. **Assisted release（推荐）**：倒计时结束自动打开官方释放对话框，并显示模态提示“请在 Quick Pick 中确认释放”。用户按一次 Enter 即完成；如果用户不在，runtime 继续计费，但不会误杀。
2. **Opt-in UI automation（不推荐）**：仅在“恰好只有一个 assigned server、且已知 serverId/label”时，等待 QuickPick 出现后调用 `workbench.action.acceptSelectedQuickOpenItem`。仍可能误判，默认关闭，需显式开启并显示风险。
3. **Upstream PR**：向 `googlecolab/colab-vscode` 提需求，增加非交互的 `colab.removeServerById(serverId)` 或公共 API。这是长期正解。

多服务器注意：官方 QuickPick 会列出所有 assigned/unowned 服务器，用户可能选错。释放提示必须显示当前监控 server 的 label 与 serverId 前 8 位；如果命令 resolve 后当前 server 仍存在，按 `RELEASE_CANCELLED` 处理，并提示“你释放的可能不是当前监控的 server”。

成功判定优先级（从强到弱）：

1. 挂载的 `colab://<serverId>/content` workspace folder 被移除（官方 `unassignServer` 会触发）。
2. `getActiveKernels()` 不再返回该 server 的 kernel（Kernel API 模式）。
3. `workspace.fs.stat(colab://<serverId>/content)` 连续失败且错误为 `Unavailable` / `FileNotFound`；**不要**把一次网络瞬断当成释放成功，至少重试 5 秒。

---

### 3.4 配置项

| Key | 类型 | 默认 | 作用域 | 说明 |
| --- | --- | --- | --- | --- |
| `colabdeck.probe.sampleIntervalMs` | number | `5000` | window | 1–60s；越小历史越细、文件越大 |
| `colabdeck.probe.launchMethod` | enum | `auto` | window | `auto`/`kernel`/`terminal` |
| `colabdeck.probe.probeDir` | string | `/content/.colabdeck` | window | 只允许 `/content/` 或 `/tmp/` 前缀 |
| `colabdeck.idleGuard.enabled` | boolean | `true` | window | 总开关 |
| `colabdeck.idleGuard.gpuUtilizationThresholdPct` | number | `5` | window | 0–100 |
| `colabdeck.idleGuard.idleDebounceMs` | number | `5000` | window | 连续低于阈值多久才算“进入 idle” |
| `colabdeck.idleGuard.idleThresholdMinutes` | number | `5` | window | 连续 idle 多久开始倒计时 |
| `colabdeck.idleGuard.countdownSeconds` | number | `120` | window | 倒计时长度 |
| `colabdeck.idleGuard.staleSampleSeconds` | number | `15` | window | 超过即 stale，Idle Guard 失效安全 |
| `colabdeck.idleGuard.minRuntimeMinutes` | number | `5` | window | 连接后的宽限期 |
| `colabdeck.idleGuard.snoozeMinutes` | number | `30` | window | snooze 时长 |
| `colabdeck.idleGuard.autoRelease` | boolean | `true` | window | 倒计时结束是否调用官方释放命令 |
| `colabdeck.idleGuard.requireKernelIdle` | enum | `auto` | window | `auto`/`always`/`never`；`auto` 仅在已知 busy 时抑制 |
| `colabdeck.dashboard.timeRange` | enum | `30m` | window | `15m`/`30m`/`1h` |
| `colabdeck.dashboard.showProcesses` | boolean | `true` | window | 是否默认展开进程表 |
| `colabdeck.logging.level` | enum | `info` | window | `off`/`error`/`warn`/`info`/`debug`/`trace` |
| `colabdeck.server.lastId` | string | — | machine | 内部持久化，不建议手改 |

说明：

- `requireKernelIdle=auto`：有 Kernel API 时，若主内核 `status === 'busy'` 则抑制自动释放；无 Kernel API 时按 GPU-only 处理。
- `autoRelease=false` 时，倒计时结束只停在 `COUNTDOWN_WARNING`（`phase='expired'`），等待用户点击 “Release now”。
- 所有配置变化都会触发 `SETTINGS_CHANGED`；关闭 `enabled` 会立即取消计时器并转 `DISABLED`。

---

### 3.5 错误模型

```ts
export type ColabDeckErrorCode =
  | 'JUPYTER_API_ACCESS_DENIED'
  | 'WORKSPACE_NOT_TRUSTED'
  | 'NO_ACTIVE_COLAB_KERNEL'
  | 'SERVER_ID_UNAVAILABLE'
  | 'SERVER_UNAUTHORIZED'
  | 'SERVER_UNAVAILABLE'
  | 'PROBE_WRITE_FAILED'
  | 'PROBE_LAUNCH_FAILED'
  | 'PROBE_STALE'
  | 'PROBE_PROTOCOL_MISMATCH'
  | 'PROBE_COMMAND_TIMEOUT'
  | 'PROBE_COMMAND_REJECTED'
  | 'RELEASE_COMMAND_UNAVAILABLE'
  | 'RELEASE_FAILED'
  | 'RELEASE_INTERACTIVE_ONLY'
  | 'CUDA_CACHE_KERNEL_BUSY'
  | 'CUDA_CACHE_KERNEL_UNAVAILABLE'
  | 'DISK_SCAN_FAILED'
  | 'KILL_REJECTED'
  | 'UNKNOWN';

export interface ColabDeckError {
  readonly code: ColabDeckErrorCode;
  readonly message: string;
  readonly detail: string | null;
  readonly recoverable: boolean;
  readonly action: 'RETRY' | 'OPEN_SETTINGS' | 'OPEN_PROBE_LOG' | 'NONE';
  readonly cause: unknown;
}
```

| Code | 用户动作 | 恢复 |
| --- | --- | --- |
| `JUPYTER_API_ACCESS_DENIED` | 运行 `jupyter.manageAccessToKernels` 或改用挂载模式 | 可恢复 |
| `WORKSPACE_NOT_TRUSTED` | 信任工作区 | 可恢复 |
| `NO_ACTIVE_COLAB_KERNEL` | 打开 notebook 并启动 Colab kernel | 可恢复 |
| `SERVER_ID_UNAVAILABLE` | 挂载 server 或授权 Kernel API | 可恢复 |
| `SERVER_UNAUTHORIZED` | 登录 Colab | 可恢复 |
| `PROBE_LAUNCH_FAILED` | 打开 Probe Log / 重试 | 可恢复 |
| `PROBE_STALE` | 手动 Retry；不会自动打开或关闭终端 | 可恢复 |
| `PROBE_PROTOCOL_MISMATCH` | 重装探针 | 可恢复 |
| `RELEASE_COMMAND_UNAVAILABLE` | 安装/启用官方 Colab 扩展 | 可恢复 |
| `RELEASE_INTERACTIVE_ONLY` | 在官方 QuickPick 中确认 | 可恢复 |
| `CUDA_CACHE_KERNEL_UNAVAILABLE` | 授权 Kernel API | 可恢复 |
| `KILL_REJECTED` | 检查 PID 是否仍在 GPU 进程列表 | 可恢复 |
| `UNKNOWN` | 查看 Output Channel | 不确定 |

错误处理原则：

- 所有 async 循环都必须 `try/catch` 并记录；绝不抛出未处理 rejection。
- 同一错误在 5 分钟内只向 UI 推送一次（按 `code + serverId` 去重）。
- 可恢复错误提供 `RETRY`；不可恢复错误提供 `OPEN_SETTINGS` 或 `OPEN_PROBE_LOG`。
- 绝不把 token、headers、完整远端命令行写入错误消息。

---

## 4. MVP 最小闭环验证

### 4.1 目标

用最少的代码先证明一件事：**在训练主内核被阻塞时，ColabDeck 仍能每 5 秒拿到一条真实样本，并更新状态栏与 Webview。**

最小闭环不追求多服务器、不追求完整 Toolbox、不追求自动释放；它只验证三个关键假设：

1. 官方 `colab://` 文件系统能承载探针数据。
2. 用户打开的、名称精确匹配的官方 Colab 终端能启动一个 detached 探针，且探针不依赖 Jupyter；ColabDeck 不自动打开或销毁终端。
3. 状态栏与 Webview 能稳定消费 RingBuffer。

### 4.2 最小闭环架构

```text
┌─────────────────────────────── VS Code Extension Host ───────────────────────────────┐
│                                                                                      │
│  ServerRegistry ──► ProbeInstaller ──► ProbeLauncher ──► TelemetrySampler           │
│       │                   │                  │                   │                    │
│       │                   │                  │                   │                    │
│       │                   │                  │                   ├─► RingBuffer         │
│       │                   │                  │                   ├─► StatusBarItem      │
│       │                   │                  │                   └─► WebviewPanel       │
│       │                   │                  │                                             │
└───────┼───────────────────┼──────────────────┼─────────────────────────────────────────┘
        │                   │                  │
        │ workspace.fs      │ workspace.fs    │ existing Colab terminal.sendText()
        ▼                   ▼                  ▼
┌─────────────────────────────── Colab Runtime ───────────────────────────────────────┐
│                                                                                      │
│  /content/.colabdeck/                                                                │
│    colabdeck_probe.py  ──►  status.json                                               │
│                       └────►  metrics.jsonl                                          │
│                                                                                      │
│  nohup python3 colabdeck_probe.py &                                                  │
│    ├─ 读 /proc/meminfo、os.statvfs、os.getloadavg                                     │
│    ├─ 子进程 nvidia-smi（2s timeout）                                                 │
│    └─ 只写本地文件；不连接 Jupyter；不产生心跳                                        │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 分步计划

> **激活顺序**：使用 `workspace.fs` 或 Kernel API 前，先 `await vscode.extensions.getExtension('google.colab')?.activate()` 与 `ms-toolsai.jupyter` 的 `activate()`，确保 `colab://` provider 与 Kernel API 已注册。

| Step | 做什么 | 关键文件 | 验收标准 |
| --- | --- | --- | --- |
| 0. 准备 | 安装官方 Colab + Jupyter；登录；分配一台 GPU；打开 notebook 并选中 Colab kernel；挂载 server 到 workspace | 手工 | `colab://<id>/content` 出现在 workspace folders |
| 1. 发现 | 扫描当前 `workspace.workspaceFolders` 中 `scheme === 'colab'` 的 folder，得到 `serverId`/`label`；不从 `globalState` 恢复未挂载的旧 server | `server/serverRegistry.ts` | `ColabDeck: Show Server Info` 输出 serverId/label |
| 2. 安装探针 | 读取 `resources/probe/colabdeck_probe.py`，用 `workspace.fs.writeFile` 写到 `colab://<id>/content/.colabdeck/colabdeck_probe.py` | `probe/probeInstaller.ts`、`probe/probePaths.ts` | 远端 `cat` 能看到脚本；无权限错误有明确提示 |
| 3. 启动探针 | 用户先在官方 Colab 扩展中打开当前服务器终端；ColabDeck 匹配现有终端后 `sendText("nohup ... &")`，轮询 `status.json` 直到 `seq` 增长；不打开、隐藏或 dispose 终端 | `probe/launcher.ts` | `status.json` 的 `pid` 存在；`seq` 每 5s +1；终端生命周期由用户/官方扩展管理 |
| 4. 读取 | 每 5s 读 `status.json`；若 `seq` 前进则读 `metrics.jsonl`；只解析完整行；写入 RingBuffer；`seq` 倒退/`bootId` 变化则重置 | `probe/probeReader.ts`、`telemetry/telemetryStore.ts` | 日志打印一条 sample；GPU/RAM/disk 与 `nvidia-smi`/`free -h`/`df -h` 一致 |
| 5. 状态栏 | 从最新样本构造 `T4 \| VRAM 8.2/15G \| Idle Guard: ON`；点击聚焦 Webview。显存/内存用二进制 GiB、显示为 `G`、保留 1 位小数 | `statusbar/statusBarController.ts` | 文本正确；5s 内更新；点击打开侧边栏 |
| 6. Webview | Vite + Preact + uPlot；`READY` 握手；`SNAPSHOT` + `TELEMETRY_BATCH`；先画一张 GPU 利用率曲线 | `webview/dashboardProvider.ts`、`packages/webview/src/App.tsx` | 30 分钟数据可渲染；无 CSP 错误；主题变量生效 |
| 7. Idle Guard（只记录） | 实现纯 reducer + 定时器；`autoRelease=false`；验证 `ACTIVE -> IDLE_DETECTED -> COUNTDOWN_WARNING -> CANCEL` | `idleGuard/*` | 每次转换有日志；Cancel 重置；stale 探针绝不释放 |
| 8. 释放（辅助） | 开启 `autoRelease`；调用 `colab.removeServer`；检测 workspace folder 移除/FS 失效；处理用户取消 | `idleGuard/release.ts` | 官方 QuickPick 打开；确认后 `TERMINATED -> DISCONNECTED`；取消后回 `ACTIVE` |
| 9. Toolbox | 进程列表/kill（文件 RPC）；磁盘扫描；CUDA cache（主内核） | `toolbox/*` | kill 测试进程成功；扫描 `/content` 返回 top N；CUDA cache 有明确提示 |

> CUDA cache 的语义：`torch.cuda.empty_cache()` 只释放 PyTorch 的缓存块，不释放仍被引用的 tensor；UI 必须明确说明，不能承诺“释放全部显存”。

> 终端启动前检查官方配置 `colab.terminal`（默认 `true`）；如果为 `false`，提示用户开启，或改用 `kernel` 启动方式。

### 4.4 最小闭环的关键代码形状（示意，不是最终实现）

```ts
// extension.ts（组合根）
const logger = new Logger('ColabDeck');
const registry = new ServerRegistry(context, logger);
const installer = new ProbeInstaller(context, logger);
const launcher = new TerminalProbeLauncher(logger);
const store = new TelemetryStore();
const statusBar = new StatusBarController(store);
const dashboard = new DashboardProvider(context, store, logger);
const idleGuard = new IdleGuardService(logger);

registry.onDidChangeServers(async (servers) => {
  const server = servers[0];
  if (!server) return;

  await installer.install(server);
  await launcher.launch(server);

  const reader = new ProbeReader(server, context);
  const sampler = new TelemetrySampler(server, reader, store, logger);
  sampler.onSample((sample) => {
    statusBar.update(server, sample);
    dashboard.appendSample(server, sample);
    idleGuard.onSample(server, sample);
  });
  sampler.start();
});
```

```ts
// TerminalProbeLauncher（核心步骤）
const terminal = vscode.window.terminals.find(
  (item) => !item.exitStatus && (item.name === server.label || item.name === server.id),
);
if (!terminal) {
  throw new ColabDeckError('Open the matching Colab terminal first.', {
    code: 'PROBE_LAUNCH_FAILED',
    action: 'RETRY',
  });
}
terminal.sendText(
  `cd /content && COLABDECK_PROBE_DIR=${probeDir} COLABDECK_INTERVAL_MS=${intervalMs} ` +
  `nohup python3 ${probeDir}/colabdeck_probe.py </dev/null >>${probeDir}/probe.log 2>&1 &`,
  true,
);
await waitForStatus(server, 15_000);
```

### 4.5 验收标准（DoD）

功能：

- [ ] 在 T4/L4 上，训练 cell 运行 10 分钟期间，Webview 曲线每 5 秒更新，不冻结。
- [ ] 主内核执行时间与未安装 ColabDeck 时相比无显著差异（±5%，排除正常波动）。
- [ ] GPU 利用率/显存/RAM/磁盘/温度与 `nvidia-smi`、`free -h`、`df -h` 读数一致（误差 <5%）。
- [ ] 状态栏显示 `T4 | VRAM 8.2/15G | Idle Guard: ON`，点击打开侧边栏。
- [ ] 手动 `kill <probe pid>` 后，15 秒内状态栏显示 `STALE`，停止采样并提示用户手动 Retry；不自动打开或关闭终端。
- [ ] Idle Guard 的每次状态转换都有日志；Cancel 后回到 `ACTIVE` 并重置计时。
- [ ] 停止探针/断开 server 时，Idle Guard 绝不调用释放命令。
- [ ] 官方 `colab.removeServer` 打开 QuickPick；用户确认后 server 被移除；取消后回到 `ACTIVE`。
- [ ] 进程列表能显示 PID/名称/显存；kill 前有确认；kill 后列表刷新。
- [ ] 磁盘扫描只允许 `/content` 或 `/tmp`，返回 top N。
- [ ] CUDA cache 清理只通过主内核 `executeCode`，并明确提示“等待当前 cell 结束”。

边界：

- [ ] 代码中不出现 `api/colab/resources`、`/colab/tty`、`colabApiClient`、`deleteRuntime`、`v1/user-info`。
- [ ] 探针不 import Jupyter/requests/websocket；`ss -tp` / `lsof` 看不到 Jupyter 连接。
- [ ] 扩展不存储 token/headers；不向 Webview 发送 `serverSettings`。
- [ ] 不实现任何周期性 Jupyter 消息（避免假心跳）。
- [ ] 不实现 QuickPick 自动确认（除非你明确选择 opt-in 方案）。

### 4.6 现场测试矩阵

| 维度 | 取值 |
| --- | --- |
| GPU | T4、L4、A100（如有）、CPU-only |
| Colab 扩展 | 项目支持版本、最新稳定版 |
| Jupyter 扩展 | 项目支持版本、最新稳定版 |
| VS Code | 1.99.3、当前 stable |
| Python | 3.10、3.11、3.12 |
| 工作区 | 单 folder、多 root、无 folder（仅 Kernel API 路径） |
| 服务器数量 | 1、2 |
| 探针状态 | 正常、stale、崩溃、重启、runtime 回收 |
| Idle Guard | active、idle、countdown、cancel、snooze、release、stale、kernel busy |
| 释放 | 确认、取消、多服务器、命令不可用 |
| 主题 | light、dark、high contrast |

### 4.7 MVP 不做清单

- 不做多服务器并行监控（先做选择器 + 单服务器）。
- 不做自动释放的 UI 自动确认（除非你选择 opt-in）。
- 不做 TPU 指标（`nvidia-smi` 不适用；先标记 `UNSUPPORTED`）。
- 不做删除文件/清理磁盘（只扫描，不删除）。
- 不做历史数据持久化（RingBuffer 仅内存；重启后从 metrics.jsonl 回填）。
- 不做遥测/崩溃上报。
- 不做官方 Resources 树的替代 UI；我们只做自己的曲线与 Toolbox。

---

## 5. 风险与已确定选择

### 5.1 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `colab.removeServer` 总是交互式 | 无法完全无人值守释放 | Assisted release；上游 PR；不模拟按键 |
| Jupyter Kernel API 需要一次性授权 | 自动发现可能被拒 | 挂载 server 的降级路径；引导用户授权 |
| Colab 可能限制额外 kernel | 临时 kernel 启动失败 | 自动回退官方终端启动 |
| `nvidia-smi` per-process memory 不可用 | 进程表缺少显存 | procfs 回退；UI 显示 “—” 并标注来源 |
| `metrics.jsonl` 读取开销 | 5s 全量读文件 | 默认 5s；文件轮转 2MB；后续可加 Range/分钟桶 |
| 时钟偏移 | 图表与 staleness 误判 | 图表用远端时间；staleness 用本地接收时间 |
| 多服务器 | 释放错服务器 | 只对选中的 server；释放前再次校验 label；MVP 建议单服务器 |
| 探针崩溃循环 | 额外 CPU/IO | 最多 3 次指数退避；熔断；手动 Retry |
| 探针卡死但锁未释放 | 无法重启探针 | `Restart Probe` 命令通过官方终端执行 `pkill -f colabdeck_probe.py`，再重装 |
| 官方扩展版本漂移 | 命令/API 失效 | 启动时能力检测；降级到手动模式；日志明确 |
| 非 trusted workspace | Kernel API 拒绝 | `untrustedWorkspaces: false`；显示信任提示 |
| 官方终端可见 | 启动时闪一下 | 启动后立即隐藏 |
| 探针脚本被用户修改 | 采样异常 | 启动时校验 protocol/bootId；失败则重装 |
| 多服务器切换 | Idle Guard 状态串台 | 切换 server 时重置 Idle Guard 为 `DISCONNECTED`，再重新评估 |

### 5.2 已确定的实现选择

当前实现采用 npm workspaces 单仓：`shared` 定义协议与纯函数，`probe` 负责远端采集，`extension` 负责 VS Code 集成，`webview` 负责 Dashboard。Idle Guard、Toolbox 和现场验收均遵循本文契约。

这些选择构成当前实现的约束；变更时应通过新的设计评审记录。

---

## Appendix A. 已拒绝的替代方案

| 方案 | 为什么拒绝 |
| --- | --- |
| 直接轮询 `api/colab/resources` | 未文档化的 Colab runtime 端点；不含温度/进程；不符合“只用公共接口”的边界 |
| 自行实现 `/colab/tty` WebSocket | 需要复刻 Colab 认证头与私有终端协议；官方命令已经可用 |
| 长驻 monitor kernel 持续 `nvidia-smi` | 持续的 Jupyter 活动可能被当成心跳，违反“不做假心跳保活” |
| 在主内核 `executeCode('nvidia-smi')` | 训练时主内核阻塞，面板假死；明确禁止 |
| 解析官方终端输出 | 稳定 API 读不到自定义 PTY 输出；shell integration 也不注入 |
| `workbench.action.acceptSelectedQuickOpenItem` | 可能接受错误的 QuickPick/服务器；不安全 |
| `colabApiClient.deleteRuntime` | Google 私有 API；禁止 |
| 从 runtime 内 `kill -9 1` | 不是“释放”，可能留下脏状态 |
| 读取官方 `colab.consumptionStatusBar` | 其他扩展不可读；也不应重复计费信息 |

---

## Appendix B. 时序图

### B.1 启动与采样

```text
User                 VS Code                  ColabDeck Host             Colab Runtime
 │                      │                           │                          │
 │-- mount server ----->│                           │                          │
 │                      │-- workspaceFolders ------>│                          │
 │                      │                           │-- write probe.py ------->│
 │                      │                           │-- existing terminal.sendText() -->│
 │                      │                           │   (official terminal)    │
 │                      │                           │-- sendText(nohup...) -->│
 │                      │                           │                          │-- start probe
 │                      │                           │<-- status.json ----------│
 │                      │                           │-- read metrics.jsonl --->│
 │                      │                           │<-- SAMPLE ---------------│
 │                      │<-- status bar text -------│                          │
 │                      │<-- Webview postMessage ---│                          │
```

### B.2 Idle Guard

```text
Probe                Host Sampler              IdleGuardService            UI
 │-- SAMPLE ---------->│                            │                        │
 │                     │-- onSample --------------->│                        │
 │                     │                            │-- reducer ------------->│
 │                     │                            │-- LOG_TRANSITION ----->│
 │                     │                            │-- START_IDLE_TIMER ----│
 │                     │                            │<-- IDLE_THRESHOLD -----│
 │                     │                            │-- COUNTDOWN_WARNING --->│
 │                     │                            │-- SHOW_NOTIFICATION --->│
 │                     │                            │<-- CANCEL --------------│
 │                     │                            │-- ACTIVE ------------->│
```

### B.3 释放

```text
IdleGuardService             VS Code Commands          Official Colab          Runtime
      │                            │                          │                    │
      │-- COUNTDOWN_EXPIRED ------>│                          │                    │
      │-- TERMINATING ----------->│                          │                    │
      │-- executeCommand('colab.removeServer') ------------>│                    │
      │                            │                          │-- QuickPick ------->│
      │                            │                          │<-- user confirm ---│
      │                            │                          │-- unassignServer -->│
      │<-- Promise resolve --------│                          │                    │
      │-- workspace.fs.stat ---------------------------------->│                    │
      │<-- Unavailable ---------------------------------------│                    │
      │-- TERMINATED ----------->│                           │                    │
      │-- DISCONNECTED --------->│                           │                    │
```

---

## Appendix C. 术语

| 术语 | 含义 |
| --- | --- |
| **Server / Assigned Server** | 官方 Colab 扩展分配并维护的 Colab runtime；其 `id` 就是 `colab://` 的 authority |
| **Probe** | 运行在 Colab runtime 上的独立 Python 后台脚本 `colabdeck_probe.py` |
| **Sample** | 探针一次采样产生的 JSON 对象（`ProbeSample`） |
| **RingBuffer** | Extension Host 内按服务器保存的固定容量遥测环形缓冲 |
| **Idle Guard** | 基于 GPU 利用率的闲置检测、倒计时提醒与辅助释放状态机 |
| **Assisted Release** | 自动打开官方释放对话框，由用户确认；不模拟按键 |
| **Kernel API** | `ms-toolsai.jupyter` 导出的公共 Kernel API，需一次性授权 |

---
