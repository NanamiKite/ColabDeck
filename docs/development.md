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
npm run package:vsix # 构建并打包到 release/colabdeck-<version>.vsix
npm run publish:vsix # 把 release/ 里最新的 VSIX 发布到 Marketplace
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

## 打包 VSIX

`npm run package:vsix` 先执行 `npm run build`，再用 `@vscode/vsce` 打包到 `release/colabdeck-<version>.vsix`。打包前检查 `publisher`、`repository`、`icon`、`README.md`、`LICENSE.txt` 和构建同步出来的探针文件，缺任何一个直接退出，不等到构建完才失败。

- `--no-dependencies`：扩展由 esbuild 打包成 `dist/extension.js`，VSIX 里不放 `node_modules`。
- VSIX 内容由 `packages/extension/.vscodeignore` 控制：排除 `src/`、`*.map`、`smoke/`，保留 `dist/`、`resources/`（含探针）、`README.md`、`LICENSE.txt`。
- `--pre-release` 打成预发布包。Marketplace 不接受 `0.1.0-beta` 这类 semver 预发布版本号，预发布只能靠这个标记。

本机安装验证：`code --install-extension release/colabdeck-<version>.vsix`。

## 发布到 Marketplace

扩展 ID 是 `nanami.colabdeck`，来自 `packages/extension/package.json` 的 `publisher` 和 `name`。

一次性准备：

1. 在 <https://marketplace.visualstudio.com/manage/publishers/> 创建 publisher，ID 必须等于 `publisher`（当前 `nanami`）。ID 创建后不能改。
2. 选一种发布凭据：

| 方式 | 用法 | 说明 |
| --- | --- | --- |
| Trusted Publishing（GitHub Actions） | `npm run publish:vsix -- --oidc --yes` | 在 publisher 管理页创建 Trusted Publishing 策略，其中 workflow 文件名要和 `.github/workflows/` 下的文件一致；workflow 需要 `permissions.id-token: write`。官方推荐。 |
| Microsoft Entra ID | `az login`，然后 `npm run publish:vsix -- --azure-credential` | 登录账号必须是该 publisher 的成员。 |
| Personal Access Token | `export VSCE_PAT=<token>` | 官方已标记为不推荐；Azure DevOps 的全局 PAT 在 2026-12-01 退役。 |

PAT 的 Organization 选 All accessible organizations，Scopes 选 Marketplace → Manage；只选单个组织会得到 401 / 403。Token 只走环境变量，不要写进命令行或提交到仓库。

每次发布：

1. 把 `packages/extension/package.json` 的 `version` 改成新版本。Marketplace 不接受重复版本。
2. `npm run package:vsix`，先用 VSIX 本地装一遍。
3. `npm run publish:vsix`。脚本默认取 `release/` 里最新的 VSIX，也可以显式传路径；发布前列出 `publisher.name`、版本和目标页面，确认后才执行。`--yes` 跳过确认，非交互环境必须带它。
4. 到 <https://marketplace.visualstudio.com/items?itemName=nanami.colabdeck> 确认，并用 `code --install-extension nanami.colabdeck` 装一次。

## 目录

```text
packages/
  shared/      协议类型与 zod 校验、RingBuffer、下采样、Idle Guard 纯 reducer
  probe/       colabdeck_probe.py（仅标准库，运行在 Colab runtime）与 pytest
  extension/   Extension Host：服务器发现、探针安装与启动、增量读取、状态栏、Webview 宿主、Idle Guard 服务、工具箱
  webview/     Preact + uPlot Dashboard
scripts/
  sync-probe.mjs    把 packages/probe/colabdeck_probe.py 复制到 packages/extension/resources/probe
  smoke.mjs         桌面版 VS Code 激活冒烟测试
  package-vsix.mjs  构建并打包 VSIX 到 release/
  publish-vsix.mjs  把 VSIX 发布到 Marketplace
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
