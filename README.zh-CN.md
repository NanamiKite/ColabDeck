# ColabDeck

官方 Google Colab VS Code 扩展（`google.colab`）的伴生面板。训练时看 GPU 曲线不卡内核，GPU 闲下来倒计时提醒你释放 runtime，再附一组以只读为主的排障工具。

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-0078D4?style=flat&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=NanamiKite.colabdeck) [![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue?style=flat)](LICENSE)

[快速开始](#快速开始) · [文档](#文档) · [配置](docs/configuration.md) · [已知限制](#已知限制) · [English](README.md)

![ColabDeck Dashboard：GPU 指标与曲线、Idle Guard 倒计时、GPU 进程表](docs/images/dashboard.png)

## 它做三件事

- **监控**：GPU 利用率、VRAM（含窗口峰值）、系统 RAM、磁盘四条曲线，加 GPU 温度、功耗、CPU 负载读数。采集由 runtime 里的独立进程完成，训练 cell 跑着也能刷新。
- **Idle Guard**：GPU 连续低于 5% 满 5 分钟后开始 120 秒倒计时，可 Cancel / Snooze / Release now。倒计时结束打开官方释放对话框，由你确认。
- **工具箱**：GPU 进程表、带确认的 Kill、只读磁盘大文件扫描、通过主内核清 CUDA 缓存。

## 快速开始

前置：VS Code >= 1.99.3，已安装并登录官方 `google.colab` 和 `ms-toolsai.jupyter`。

1. 从 Marketplace 安装：在扩展面板（`Ctrl+Shift+X`）搜索 `ColabDeck`，或在命令面板执行 `ext install NanamiKite.colabdeck`。
2. 在官方 Colab 扩展中分配 runtime。
3. 点击活动栏或状态栏打开 Dashboard，点击 **Mount server**。Dashboard 默认在侧边栏打开，拖宽后呈两列布局。
4. 状态变为 `connected` 后曲线开始更新。

一直停在 `Starting`：点 **Refresh**；错误卡里有 **Retry** 和 **View diagnostics**。连接处于 `error` / `stale`，或已选服务器但 `disconnected` 时，头部会出现 **Restart probe**。

<details>
<summary><b>从源码安装</b></summary>

开发用。需要 Node.js >= 20、npm >= 10。克隆仓库后：

```bash
npm install
npm run package:vsix
code --install-extension release/colabdeck-<version>.vsix
```

调试运行、测试和上架流程见 [开发文档](docs/development.md)。

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
- 一次只监控一个选中的服务器。
- 启动采集时官方终端会短暂闪现。
- 不显示算力点余额：ColabDeck 不调用 Google 私有配额接口，也不模拟 Jupyter / Colab 私有协议。
- GPU 温度和功耗依赖 `nvidia-smi`，个别机型返回 `[N/A]`，显示为 `—`。

## 许可证

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
