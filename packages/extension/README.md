# ColabDeck

Companion operations and cost-control panel for the official Google Colab VS Code extension.

## Features

- Non-blocking GPU/VRAM/RAM/disk/temperature telemetry sampled by a detached standard-library probe.
- Idle Guard state machine with countdown, cancel/snooze, fail-safe disconnect handling, and assisted release through the official `colab.removeServer` dialog.
- GPU process list with guarded kill, read-only disk scan, and CUDA cache cleanup through the notebook kernel.
- Status bar summary and Preact + uPlot dashboard.

## Requirements

- VS Code >= 1.99.3
- `google.colab` and `ms-toolsai.jupyter` installed and signed in

## Usage

1. Assign a Colab runtime in the official Colab extension.
2. Open the ColabDeck view from the Activity Bar or click the status bar item, then choose **Mount server**.
3. Configure thresholds in Settings → Extensions → ColabDeck.

ColabDeck never calls private Google billing/quota APIs, never maintains OAuth state, and never auto-confirms the official release QuickPick.

## License

GPL-3.0-or-later. See `LICENSE.txt`.
