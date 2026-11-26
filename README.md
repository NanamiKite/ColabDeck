# ColabDeck

官方 Google Colab VS Code 扩展（`google.colab`）的伴生面板：训练时看 GPU 曲线不卡内核，GPU 闲下来提醒你释放 runtime，再附一个以只读为主的排障工具箱。

[快速开始](#快速开始) · [文档](#文档) · [配置](docs/configuration.md) · [已知限制](#已知限制)

## 它做三件事

- **监控**：GPU 利用率、VRAM（含窗口峰值）、系统 RAM、磁盘曲线，加 GPU 温度、功耗、CPU 负载读数。采集由 runtime 内的独立进程完成，训练 cell 跑着也能刷新。
- **Idle Guard**：GPU 连续低于 5% 满 5 分钟后开始 120 秒倒计时，可 Cancel / Snooze / Release now。倒计时结束打开官方释放对话框，由你确认。
- **工具箱**：GPU 进程表、带确认的 Kill、只读磁盘大文件扫描、通过主内核清 CUDA 缓存。

## 快速开始

前置：VS Code >= 1.99.3，已安装并登录官方 `google.colab` 和 `ms-toolsai.jupyter`。

1. 安装扩展：克隆仓库后 `npm install && npm run package:vsix`，在 VS Code 中安装 `release/` 下生成的 VSIX。开发时也可以直接按 `F5`。
2. 在官方 Colab 扩展中分配 runtime。
3. 点击活动栏或状态栏打开 Dashboard，点击 **Mount server**。Dashboard 默认在侧边栏打开，拖宽后呈两列布局。
4. 状态变为 `connected` 后曲线开始更新。

一直停在 `Starting`：点 **Refresh**；错误卡里有 **Retry** 和 **View diagnostics**。连接处于 `error` / `stale`，或已选服务器但 `disconnected` 时，头部会出现 **Restart probe**。

<details>
<summary><b>F5 启动后闪退（退出码 134）</b></summary>

VS Code 1.146.0 + js-debug 1.140.1 下，Extension Development Host 可能在几秒内退出并报 `134`。仓库已在 `.vscode/settings.json` 关闭 `debug.javascript.enableNetworkView`；如果工作区或用户设置覆盖了它，改回 `false` 后重启 VS Code。

</details>

## 文档

| 想知道 | 看这里 |
| --- | --- |
| 指标从哪来、Colab 能给什么、时间窗、stale 判定 | [监控](docs/monitoring.md) |
| Idle Guard 状态、阈值、释放流程 | [Idle Guard](docs/idle-guard.md) |
| 进程表、Kill、磁盘扫描、CUDA 缓存 | [工具箱](docs/toolbox.md) |
| 每个设置项的默认值和取值范围 | [配置](docs/configuration.md) |
| 构建、测试、打包与发布、目录结构、代码地图 | [开发](docs/development.md) |
| 探针文件与 Webview 消息协议 | [protocol.md](docs/protocol.md) |
| 完整架构、转换表与决策记录 | [phase-1-architecture.md](docs/phase-1-architecture.md) |
| 真实 Colab 验收清单 | [mvp-validation.md](docs/mvp-validation.md) |

## 已知限制

- 释放需要在官方对话框里确认；"自动释放"只是把对话框打开。
- 启动采集时官方终端会短暂闪现。
- 一次只监控一个选中的服务器。
- GPU 温度和功耗依赖 `nvidia-smi`，个别机型返回 `[N/A]`，显示为 `—`。
- 不调用 Google 私有计费 / 配额接口，不模拟 Jupyter / Colab 私有协议；探针只读指标，不执行任意远端命令。
