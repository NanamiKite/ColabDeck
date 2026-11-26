# 开发

## 环境

- Node.js >= 20，npm >= 10
- Python >= 3.10（跑探针测试需要 pytest）
- VS Code >= 1.99.3，已安装官方 `google.colab` 和 `ms-toolsai.jupyter`

## 常用命令

```bash
npm install
npm run build        # shared → webview → extension → 复制探针到 packages/extension/resources/probe
npm run typecheck    # 先构建 shared，再对每个 workspace 执行 tsc --noEmit
npm test             # shared + extension 的 Vitest，然后 packages/probe 的 pytest
npm run test:smoke   # 构建后在桌面版 VS Code 里加载扩展，检查激活
npm run package:vsix # 构建并打包到 packages/extension/*.vsix
```

`npm test` 用全局 `python3 -m pytest`。本机没装 pytest 时：

```bash
uv venv .venv
uv pip install --python .venv/bin/python pytest
.venv/bin/python -m pytest packages/probe -q
```

单独跑某一部分：`npm run test:shared`、`npm run test:extension`、`npm run test:probe`。

## 调试

`F5` 运行 `ColabDeck: Extension` 配置：先执行 `npm: build`，再打开 Extension Development Host。**Mount server** 需要官方 Colab 扩展已登录。

<details>
<summary><b>Extension Development Host 闪退（退出码 134）</b></summary>

VS Code 1.146.0 + js-debug 1.140.1 下，js-debug 在扩展宿主 inspector 初始化前发送 `Network.enable`，触发 Electron 的 Node 断言并以 `134` 退出。仓库已在 `.vscode/settings.json` 把 `debug.javascript.enableNetworkView` 设为 `false`；工作区或用户设置若覆盖为 `true`，改回后重启 VS Code。

</details>

运行期日志在输出面板 **ColabDeck**，级别由 `colabdeck.logging.level` 控制。

## 目录

```text
packages/
  shared/      协议类型与 zod 校验、RingBuffer、下采样、Idle Guard 纯 reducer
  probe/       colabdeck_probe.py（仅标准库，运行在 Colab runtime）与 pytest
  extension/   Extension Host：服务器发现、探针安装与启动、增量读取、状态栏、Webview 宿主、Idle Guard 服务、工具箱
  webview/     Preact + uPlot Dashboard
scripts/
  sync-probe.mjs  把 packages/probe/colabdeck_probe.py 复制到 packages/extension/resources/probe
  smoke.mjs       桌面版 VS Code 激活冒烟测试
```

依赖方向：`extension` 和 `webview` 都依赖 `shared`，`shared` 不依赖它们，`probe` 没有 npm 依赖。改了 `shared` 要先 `npm run build:shared`，否则 `webview` 的类型检查会读到旧产物。

## 代码地图

| 要改什么 | 位置 |
| --- | --- |
| 探针采样、命令处理 | `packages/probe/colabdeck_probe.py` |
| 探针文件协议、Webview 消息 | `packages/shared/src/protocol/` |
| Idle Guard 状态机 | `packages/shared/src/idleGuard/reducer.ts`；宿主侧 `packages/extension/src/idleGuard/idleGuardService.ts` |
| 配置读取与校验 | `packages/extension/src/config.ts`；声明在 `packages/extension/package.json` |
| 采样、stale 判定、探针重启 | `packages/extension/src/telemetry/monitoringService.ts` |
| 历史窗口 | `packages/extension/src/telemetry/store.ts`、`packages/shared/src/telemetry.ts` |
| 探针安装与启动 | `packages/extension/src/probe/installer.ts`、`launcher.ts` |
| 工具箱 | `packages/extension/src/toolbox/toolboxService.ts`、`packages/extension/src/jupyter/kernelClient.ts` |
| Webview 消息路由 | `packages/extension/src/webview/dashboardProvider.ts` |
| Dashboard 组件 | `packages/webview/src/components/` |
| 命令面板入口 | `packages/extension/src/commands/index.ts` |

## 设计文档

协议速查见 [`protocol.md`](protocol.md)；完整设计、状态机转换表与决策记录见 [`phase-1-architecture.md`](phase-1-architecture.md)。
