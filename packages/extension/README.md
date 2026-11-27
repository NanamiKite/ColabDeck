# ColabDeck

Companion operations and cost-control panel for the official Google Colab VS Code extension.

## Features

- GPU/VRAM/RAM/disk/temperature telemetry from either a private sampler attached to the active Python notebook or a detached standard-library probe on a mounted runtime.
- Idle Guard state machine (mounted-runtime mode) with countdown, cancel/snooze, fail-safe disconnect handling, and assisted release through the official `colab.removeServer` dialog.
- Mounted-runtime GPU process list with guarded kill and a read-only disk scan.
- Status bar summary and Preact + uPlot dashboard.

## Requirements

- VS Code >= 1.99.3
- `google.colab` and `ms-toolsai.jupyter` installed and signed in

## Usage

1. Assign a Colab runtime in the official Colab extension and open its connected `.ipynb`.
2. For notebook monitoring, run a cell once, leave the Python kernel idle, open ColabDeck, and click **Start monitoring** under **Notebook**. Run training normally; when the kernel is idle, click **Sync samples**.
3. To monitor a mounted server instead, switch to **Mounted runtime**, click **Mount server** if needed, then click **Start Monitoring**. If no probe is running, open the matching runtime terminal in the official Colab extension, wait for it to connect, then click **Retry Monitoring**.

**Refresh** updates the dashboard without starting the probe. If the dashboard reports a monitoring error, click **Retry Monitoring**. Configure thresholds in Settings → Extensions → ColabDeck.

Notebook monitoring requires a trusted workspace and an active Python Jupyter kernel. It submits only bounded helper requests through that kernel for start, sync, and stop; it does not mount a workspace or open a terminal. Idle Guard and the toolbox remain available only for mounted-runtime monitoring.

ColabDeck never calls private Google billing/quota APIs, never maintains OAuth state, and never auto-confirms the official release QuickPick.

## License

GPL-3.0-or-later. See `LICENSE.txt`.
