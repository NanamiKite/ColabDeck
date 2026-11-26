from __future__ import annotations

import importlib.util
import json
import logging
import os
import sys
import time
from pathlib import Path
from types import ModuleType

import pytest


PROBE_PATH = Path(__file__).resolve().parents[1] / "colabdeck_probe.py"


@pytest.fixture(scope="session")
def probe() -> ModuleType:
    spec = importlib.util.spec_from_file_location("colabdeck_probe", PROBE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_redact_and_truncate(probe: ModuleType) -> None:
    value = "python train.py --token=abc123 --api-key def456 key=zzz password: hunter2"
    redacted = probe.redact(value)
    assert "abc123" not in redacted
    assert "def456" not in redacted
    assert "hunter2" not in redacted
    assert "<redacted>" in redacted
    assert len(probe.truncate_command("x" * 500, 200)) == 200


def test_parse_gpu_rows(probe: ModuleType) -> None:
    rows = [
        ["0", "GPU-abc", "Tesla T4", "42", "1024", "15360", "65", "70.5"],
        ["1", "GPU-def", "NVIDIA A100-SXM4-40GB", "0", "2048", "40960", "30", "20"],
    ]
    gpus, error = probe._parse_gpu_rows(rows, has_uuid=True)
    assert error is None
    assert len(gpus) == 2
    assert gpus[0]["name"] == "Tesla T4"
    assert gpus[0]["memoryUsedBytes"] == 1024 * 1024 * 1024
    assert gpus[0]["memoryPeakBytes"] is None
    assert gpus[1]["index"] == 1


def test_validate_command_rejects_unknown_and_expired(probe: ModuleType) -> None:
    now = 10_000_000
    with pytest.raises(probe.CommandRejected):
        probe.validate_command({"type": "SHELL", "protocol": 1, "requestId": "x", "issuedAtMs": now}, now, 1000)
    with pytest.raises(probe.CommandRejected):
        probe.validate_command(
            {
                "type": "LIST_GPU_PROCESSES",
                "protocol": 1,
                "requestId": "x",
                "issuedAtMs": now - 10_000,
            },
            now,
            1000,
        )
    command = probe.validate_command(
        {
            "type": "SCAN_DISK",
            "protocol": 1,
            "requestId": "abc",
            "issuedAtMs": now,
            "path": "/content",
            "maxEntries": 10,
            "maxDepth": 2,
        },
        now,
        1000,
    )
    assert command["maxEntries"] == 10


def test_validate_command_rejects_unknown_fields(probe: ModuleType) -> None:
    with pytest.raises(probe.CommandRejected):
        probe.validate_command(
            {
                "type": "STOP",
                "protocol": 1,
                "requestId": "x",
                "issuedAtMs": 1,
                "shell": "rm -rf /",
            },
            2,
            1000,
        )


def test_scan_disk_rejects_proc(probe: ModuleType) -> None:
    with pytest.raises(probe.CommandRejected):
        probe.scan_disk("/proc", 10, 2)
    with pytest.raises(probe.CommandRejected):
        probe.scan_disk("relative/path", 10, 2)


def test_scan_disk_allows_content_and_prunes_depth(probe: ModuleType, tmp_path: Path) -> None:
    base = tmp_path / "content"
    (base / "a" / "b").mkdir(parents=True)
    (base / "a" / "file.bin").write_bytes(b"x" * 100)
    (base / "a" / "b" / "deep.bin").write_bytes(b"y" * 200)
    (base / "root.bin").write_bytes(b"z" * 50)

    original = probe.os.path.realpath
    probe.os.path.realpath = lambda path: str(base) if path == "/content" else original(path)
    try:
        entries, truncated = probe.scan_disk("/content", 10, 1)
    finally:
        probe.os.path.realpath = original
    paths = [entry["path"] for entry in entries]
    assert str(base / "a" / "file.bin") in paths
    assert str(base / "a" / "b" / "deep.bin") not in paths
    assert not truncated


def test_kill_process_rejects_non_gpu_pid(probe: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(probe, "query_gpu_processes", lambda _config: ([], "nvidia-smi", []))
    result = probe.kill_process(probe.ProbeConfig(Path("/tmp"), 5000, 1024, 1000, "nvidia-smi"), 12345)
    assert result["alreadyDead"] is True
    assert result["killed"] is False


def test_kill_process_protects_pid_1(probe: ModuleType) -> None:
    with pytest.raises(probe.CommandRejected):
        probe.kill_process(probe.ProbeConfig(Path("/tmp"), 5000, 1024, 1000, "nvidia-smi"), 1)


def test_atomic_write_json(probe: ModuleType, tmp_path: Path) -> None:
    target = tmp_path / "status.json"
    probe.atomic_write_json(target, {"ok": True})
    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}
    assert not target.with_name("status.json.tmp").exists()


def test_status_shape(probe: ModuleType, tmp_path: Path) -> None:
    logger = logging.getLogger("test-probe")
    logger.handlers.clear()
    state = probe.ProbeState(
        probe.ProbeConfig(tmp_path, 5000, 1024, 1000, "nvidia-smi"),
        logger,
    )
    status = state.build_status("running")
    assert status["protocol"] == 1
    assert status["seq"] == 0
    assert "command.kill" in status["capabilities"]


def test_metrics_rotation(probe: ModuleType, tmp_path: Path) -> None:
    logger = logging.getLogger("test-probe-rotation")
    logger.handlers.clear()
    config = probe.ProbeConfig(tmp_path, 5000, 256, 1000, "nvidia-smi")
    state = probe.ProbeState(config, logger)
    for seq in range(1, 6):
        state.append_sample({"type": "SAMPLE", "seq": seq, "padding": "x" * 100})
    assert (tmp_path / "metrics.1.jsonl").exists()
    assert (tmp_path / "metrics.jsonl").exists()
    assert (tmp_path / "metrics.1.jsonl").stat().st_size <= 256 + 200


def test_query_gpus_with_fake_nvidia_smi(probe: ModuleType, tmp_path: Path) -> None:
    fake = tmp_path / "nvidia-smi"
    fake.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw" ]; then\n'
        '  printf "0, GPU-abc, Tesla T4, 42, 1024, 15360, 65, 70.5\\n"\n'
        "fi\n",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    config = probe.ProbeConfig(tmp_path, 5000, 1024, 1000, str(fake))
    gpus, errors = probe.query_gpus(config, {})
    assert errors == []
    assert len(gpus) == 1
    assert gpus[0]["name"] == "Tesla T4"
    assert gpus[0]["memoryUsedBytes"] == 1024 * 1024 * 1024


def test_command_worker_reports_rejection(probe: ModuleType, tmp_path: Path) -> None:
    logger = logging.getLogger("test-probe-worker")
    logger.handlers.clear()
    config = probe.ProbeConfig(tmp_path, 5000, 1024, 1000, "nvidia-smi")
    state = probe.ProbeState(config, logger)
    worker = probe.CommandWorker(state)
    command = tmp_path / "commands" / "req-1.json"
    command.parent.mkdir(parents=True, exist_ok=True)
    command.write_text(
        json.dumps({"type": "SHELL", "protocol": 1, "requestId": "req-1", "issuedAtMs": int(time.time() * 1000)}),
        encoding="utf-8",
    )
    worker.handle_file(command)
    result = json.loads((tmp_path / "results" / "req-1.json").read_text(encoding="utf-8"))
    assert result["ok"] is False
    assert result["error"]["code"] == "UNKNOWN_COMMAND"
    assert not command.exists()


def test_read_ram_and_cpu(probe: ModuleType) -> None:
    ram = probe.read_ram()
    assert ram["source"] == "procfs"
    assert ram["totalBytes"] > 0
    cpu = probe.read_cpu()
    assert cpu["count"] >= 1
    assert os.path.isfile("/proc/meminfo")
