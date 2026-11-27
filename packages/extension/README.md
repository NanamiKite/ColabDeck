# ColabDeck

Companion operations and cost-control panel for the official Google Colab VS Code extension.

## Features

- Non-blocking GPU/VRAM/RAM/disk/temperature telemetry sampled by a detached standard-library probe.
- Idle Guard state machine with countdown, cancel/snooze, fail-safe disconnect handling, and assisted release through the official `colab.removeServer` dialog.
- GPU process list with guarded kill and a read-only disk scan.
- Status bar summary and Preact + uPlot dashboard.

## Requirements

- VS Code >= 1.99.3
- `google.colab` and `ms-toolsai.jupyter` installed and signed in

## Usage

1. Assign a Colab runtime in the official Colab extension.
2. Open ColabDeck from the Activity Bar or the status bar, then click **Mount server** if the runtime isn't already mounted.
3. Click **Start Monitoring**. If no probe is running, open the runtime's terminal in the official Colab extension, wait for it to connect, then click **Retry Monitoring**.

**Refresh** updates the dashboard without starting the probe. If the dashboard reports a monitoring error, click **Retry Monitoring**. Configure thresholds in Settings → Extensions → ColabDeck.

ColabDeck never calls private Google billing/quota APIs, never maintains OAuth state, and never auto-confirms the official release QuickPick.

## License

GPL-3.0-or-later. See `LICENSE.txt`.
