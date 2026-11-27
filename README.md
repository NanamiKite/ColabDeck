# ColabDeck

A companion panel for the official Google Colab VS Code extension (`google.colab`). Watch GPU curves while a training cell runs, get a countdown when the GPU sits idle so you can release the runtime, and use a small, mostly read-only toolbox.

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-0078D4?style=flat&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=NanamiKite.colabdeck) [![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue?style=flat)](LICENSE)

[Quick start](#quick-start) · [Docs](#docs) · [Configuration](docs/configuration.md) · [Known limitations](#known-limitations) · [简体中文](README.zh-CN.md)

![ColabDeck dashboard: GPU metrics and charts, the Idle Guard countdown, and the GPU process table](docs/images/dashboard.png)

## What it does

- **Monitoring**: GPU utilization, VRAM (with window peak), system RAM, and disk charts, plus GPU temperature, power draw, and CPU load readouts. Choose **Notebook** to start a private sampler from the active Python Colab notebook without mounting a workspace or opening a terminal, or choose **Mounted runtime** to monitor a mounted server with the detached probe.
- **Idle Guard (Mounted runtime)**: after the GPU stays below 5% for 5 minutes, a 120-second countdown starts. Cancel, snooze, or release. When the countdown ends, the official release dialog opens; you confirm it.
- **Toolbox (Mounted runtime)**: GPU process list with a confirmed Kill, and a read-only scan for large files.

## Quick start

You need VS Code >= 1.99.3 with the official `google.colab` and `ms-toolsai.jupyter` extensions installed and signed in. Notebook monitoring also needs a trusted workspace and an active Python notebook kernel.

1. Install ColabDeck from the Marketplace: open Extensions (`Ctrl+Shift+X`) and search for `ColabDeck`, or run `ext install NanamiKite.colabdeck` from the Command Palette.
2. Assign a runtime in the official Colab extension and open the `.ipynb` connected to that runtime. Run a cell once so the Python kernel is ready.
3. Open ColabDeck from the Activity Bar or the status bar. The default **Notebook** source needs no workspace mount or terminal. Click **Start Monitoring** while the kernel is idle.
4. Run your training cell. The sampler runs independently while the cell is busy. When the kernel is idle again, click **Sync samples** to bring new points into the charts. Click **Stop** when finished.

To use the original mounted-server flow, switch the source to **Mounted runtime**, click **Mount server**, then **Start Monitoring**. If no probe is running, open the runtime's terminal in the official Colab extension, wait for it to connect, then click **Retry Monitoring**. Mounting and **Refresh** never start monitoring by themselves.

<details>
<summary><b>Install from source</b></summary>

For development. Requires Node.js >= 20 and npm >= 10. After cloning the repository:

```bash
npm install
npm run package:vsix
code --install-extension release/colabdeck-<version>.vsix
```

Debugging, tests, and Marketplace publishing are covered in the [development guide](docs/development.md).

</details>

## Docs

The guides are written in Chinese.

| Want to know | Read |
| --- | --- |
| Metrics, Notebook and mounted-runtime sampling flows, time windows, stale detection | [Monitoring](docs/monitoring.md) |
| Idle Guard states, thresholds, release flow | [Idle Guard](docs/idle-guard.md) |
| Process list, Kill, disk scan, CUDA cache | [Toolbox](docs/toolbox.md) |
| Every setting with defaults and ranges | [Configuration](docs/configuration.md) |
| Build, test, directory layout, code map | [Development](docs/development.md) |
| Probe files and webview messages | [protocol.md](docs/protocol.md) |
| Full architecture, transition tables, decision records | [phase-1-architecture.md](docs/phase-1-architecture.md) |
| Real Colab acceptance checklist | [mvp-validation.md](docs/mvp-validation.md) |

## Known limitations

- Releasing the runtime still needs your confirmation in the official dialog; "automatic release" only opens that dialog.
- Mounted runtime mode monitors one selected server at a time.
- Notebook monitoring requires an active Python Jupyter kernel in a trusted workspace. Start, Sync samples, and Stop submit short helper requests through that kernel and therefore require it to be idle. Samples continue in a private background process while a training cell runs, but charts update only when you sync.
- Notebook monitoring does not mount a workspace, open a terminal, or provide Idle Guard and the toolbox. Switch to **Mounted runtime** for those features.
- The notebook sampler keeps a bounded history and expires if it is not synced for a long time; sync periodically during long jobs. Returning to another notebook does not stop the session automatically—return to the monitored notebook before stopping it.
- No compute-unit balance: ColabDeck does not call Google's private quota API or imitate Jupyter and Colab private protocols.
- The Jupyter extension may deny its Kernel API to this publisher. In that case Notebook monitoring reports that execution is unavailable; mounted-runtime monitoring still works without that API.
- The public Jupyter kernel lookup does not expose a verifiable Colab runtime ID; Notebook mode uses the active Python kernel selected by the user and does not claim provider identity.
- GPU temperature and power depend on `nvidia-smi`; some GPUs report `[N/A]`, shown as `—`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
