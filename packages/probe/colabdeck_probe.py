#!/usr/bin/env python3
"""ColabDeck remote probe.

Design constraints:
- Python standard library only. Never import Jupyter, requests, websocket, or torch.
- Never connect to the Jupyter server or any network endpoint.
- Never execute arbitrary shell strings from the host.
- Write only under the probe directory (default /content/.colabdeck).
"""

from __future__ import annotations

import csv
import fcntl
import json
import logging
import os
import platform
import re
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

PROTOCOL = 1
DEFAULT_PROBE_DIR = "/content/.colabdeck"
DEFAULT_INTERVAL_MS = 5000
DEFAULT_METRICS_MAX_BYTES = 2 * 1024 * 1024
DEFAULT_COMMAND_MAX_AGE_MS = 5 * 60 * 1000
NVIDIA_SMI_TIMEOUT_SECONDS = 2.0
MAX_COMMAND_LINE_LENGTH = 200
MAX_CACHED_RESULTS = 100

COMMAND_TYPES = {
    "LIST_GPU_PROCESSES",
    "KILL_PROCESS",
    "SCAN_DISK",
    "GET_PROBE_STATUS",
    "STOP",
}

CAPABILITIES = [
    "gpu.query",
    "gpu.processes",
    "ram.procfs",
    "disk.statvfs",
    "cpu.loadavg",
    "temperature.thermal",
    "command.kill",
    "command.diskScan",
    "command.stop",
]

SECRET_PATTERNS = [
    re.compile(
        r"(?i)(--?(?:token|api[-_]?key|password|passwd|secret|access[-_]?token|auth[-_]?token)"
        r"\s*(?:[=:]|\s)\s*)([\"']?)[^\s\"']+"
    ),
    re.compile(r"(?i)(\b(?:key|token|password|secret)\s*[=:]\s*)([\"']?)[^\s\"']+"),
]


class MetricError(Exception):
    """A single metric failed; the rest of the sample remains usable."""


class CommandRejected(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ProbeConfig:
    probe_dir: Path
    interval_ms: int
    metrics_max_bytes: int
    command_max_age_ms: int
    nvidia_smi: str


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def load_config() -> ProbeConfig:
    probe_dir = Path(os.environ.get("COLABDECK_PROBE_DIR", DEFAULT_PROBE_DIR)).expanduser()
    nvidia_smi = os.environ.get("COLABDECK_NVIDIA_SMI", "nvidia-smi")
    return ProbeConfig(
        probe_dir=probe_dir,
        interval_ms=_env_int("COLABDECK_INTERVAL_MS", DEFAULT_INTERVAL_MS, 1000, 60_000),
        metrics_max_bytes=_env_int(
            "COLABDECK_METRICS_MAX_BYTES", DEFAULT_METRICS_MAX_BYTES, 256 * 1024, 16 * 1024 * 1024
        ),
        command_max_age_ms=_env_int(
            "COLABDECK_COMMAND_MAX_AGE_MS", DEFAULT_COMMAND_MAX_AGE_MS, 10_000, 60 * 60 * 1000
        ),
        nvidia_smi=nvidia_smi,
    )


def setup_logging(path: Path) -> logging.Logger:
    logger = logging.getLogger("colabdeck.probe")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = logging.FileHandler(path, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
    return logger


def redact(value: str) -> str:
    redacted = value
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(lambda match: f"{match.group(1)}<redacted>", redacted)
    return redacted


def truncate_command(value: str, max_length: int = MAX_COMMAND_LINE_LENGTH) -> str:
    if len(value) <= max_length:
        return value
    return value[: max_length - 1] + "…"


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def read_json(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def read_boot_id() -> str:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text(encoding="utf-8").strip()
    except OSError:
        return "unknown"


def acquire_lock(path: Path) -> Optional[Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def release_lock(handle: Any) -> None:
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def parse_number(value: str) -> Optional[float]:
    cleaned = value.strip()
    if cleaned in {"", "[N/A]", "[Not Supported]", "N/A", "NaN", "-"}:
        return None
    try:
        number = float(cleaned)
    except ValueError:
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def parse_mib(value: str) -> Optional[int]:
    number = parse_number(value)
    if number is None or number < 0:
        return None
    return int(number * 1024 * 1024)


def _run_nvidia_smi(config: ProbeConfig, args: list[str]) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            [config.nvidia_smi, *args],
            capture_output=True,
            text=True,
            timeout=NVIDIA_SMI_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as error:
        raise MetricError("nvidia-smi was not found") from error
    except subprocess.TimeoutExpired as error:
        raise MetricError("nvidia-smi timed out after 2s") from error
    return completed.returncode, completed.stdout, completed.stderr


def _parse_gpu_rows(rows: Iterable[list[str]], has_uuid: bool) -> tuple[list[dict[str, Any]], Optional[str]]:
    gpus: list[dict[str, Any]] = []
    for row in rows:
        if not row:
            continue
        if has_uuid and len(row) < 8:
            return [], "nvidia-smi returned an unexpected GPU row"
        if not has_uuid and len(row) < 7:
            return [], "nvidia-smi returned an unexpected GPU row"
        try:
            index = int(row[0].strip())
            offset = 1 if has_uuid else 0
            uuid_value = row[1].strip() if has_uuid else None
            name = row[1 + offset].strip()
            utilization = parse_number(row[2 + offset])
            memory_used = parse_mib(row[3 + offset])
            memory_total = parse_mib(row[4 + offset])
            temperature = parse_number(row[5 + offset])
            power = parse_number(row[6 + offset])
        except (IndexError, ValueError):
            return [], "nvidia-smi returned an unexpected GPU row"
        gpus.append(
            {
                "index": index,
                "uuid": uuid_value if uuid_value and not uuid_value.startswith("[") else None,
                "name": name or "GPU",
                "utilizationPct": utilization,
                "memoryUsedBytes": memory_used,
                "memoryTotalBytes": memory_total,
                "memoryPeakBytes": None,
                "temperatureC": temperature,
                "powerWatts": power,
            }
        )
    return gpus, None


def query_gpus(config: ProbeConfig, peaks: dict[int, int]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    errors: list[dict[str, Any]] = []
    try:
        returncode, stdout, stderr = _run_nvidia_smi(
            config,
            [
                "--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
        )
    except MetricError as error:
        return [], [{"metric": "gpu", "message": str(error), "recoverable": True}]
    rows = [row for row in csv.reader(stdout.splitlines()) if row]
    gpus, parse_error = _parse_gpu_rows(rows, has_uuid=True)
    if gpus:
        for gpu in gpus:
            index = int(gpu["index"])
            used = gpu["memoryUsedBytes"]
            if used is not None:
                peaks[index] = max(peaks.get(index, 0), used)
            gpu["memoryPeakBytes"] = peaks.get(index)
        return gpus, []
    if returncode != 0 or parse_error:
        try:
            returncode, stdout, stderr = _run_nvidia_smi(
                config,
                [
                    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                    "--format=csv,noheader,nounits",
                ],
            )
        except MetricError as error:
            return [], [{"metric": "gpu", "message": str(error), "recoverable": True}]
        rows = [row for row in csv.reader(stdout.splitlines()) if row]
        gpus, parse_error = _parse_gpu_rows(rows, has_uuid=False)
        if gpus:
            for gpu in gpus:
                index = int(gpu["index"])
                used = gpu["memoryUsedBytes"]
                if used is not None:
                    peaks[index] = max(peaks.get(index, 0), used)
                gpu["memoryPeakBytes"] = peaks.get(index)
            return gpus, []
    if returncode != 0:
        detail = (stderr or stdout).strip().splitlines()
        message = detail[0] if detail else f"nvidia-smi exited with code {returncode}"
        return [], [{"metric": "gpu", "message": message[:500], "recoverable": True}]
    return [], [{"metric": "gpu", "message": parse_error or "no GPU detected", "recoverable": True}]


def _read_process_name(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _read_process_command(pid: int) -> Optional[str]:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return None
    parts = [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]
    if not parts:
        return None
    return truncate_command(redact(" ".join(parts)))


def procfs_gpu_processes() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    processes: list[dict[str, Any]] = []
    own_pid = os.getpid()
    parent_pid = os.getppid()
    try:
        entries = list(Path("/proc").iterdir())
    except OSError as error:
        return [], [{"metric": "gpu.processes", "message": str(error), "recoverable": True}]
    for entry in entries:
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid <= 1 or pid in (own_pid, parent_pid):
            continue
        name = _read_process_name(pid)
        if name and "nvidia-smi" in name.lower():
            continue
        fd_dir = entry / "fd"
        try:
            fds = list(fd_dir.iterdir())
        except OSError:
            continue
        uses_gpu = False
        for fd in fds:
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if target.startswith("/dev/nvidia"):
                uses_gpu = True
                break
        if not uses_gpu:
            continue
        processes.append(
            {
                "pid": pid,
                "name": name or f"pid {pid}",
                "command": _read_process_command(pid),
                "usedMemoryBytes": None,
                "gpuUuid": None,
            }
        )
    processes.sort(key=lambda item: item["pid"])
    return processes, []


def query_gpu_processes(config: ProbeConfig) -> tuple[list[dict[str, Any]], str, list[dict[str, Any]]]:
    errors: list[dict[str, Any]] = []
    try:
        returncode, stdout, stderr = _run_nvidia_smi(
            config,
            [
                "--query-compute-apps=pid,process_name,used_memory,gpu_uuid",
                "--format=csv,noheader,nounits",
            ],
        )
    except MetricError as error:
        errors.append({"metric": "gpu.processes", "message": str(error), "recoverable": True})
        processes, proc_errors = procfs_gpu_processes()
        return processes, ("procfs" if processes else "none"), errors + proc_errors
    if returncode != 0:
        try:
            returncode, stdout, stderr = _run_nvidia_smi(
                config,
                [
                    "--query-compute-apps=pid,process_name,used_memory",
                    "--format=csv,noheader,nounits",
                ],
            )
        except MetricError as fallback_error:
            errors.append({"metric": "gpu.processes", "message": str(fallback_error), "recoverable": True})
            processes, proc_errors = procfs_gpu_processes()
            return processes, ("procfs" if processes else "none"), errors + proc_errors
        if returncode != 0:
            processes, proc_errors = procfs_gpu_processes()
            detail = (stderr or stdout).strip().splitlines()
            errors.append(
                {
                    "metric": "gpu.processes",
                    "message": detail[0] if detail else f"nvidia-smi exited with code {returncode}",
                    "recoverable": True,
                }
            )
            return processes, ("procfs" if processes else "none"), errors + proc_errors
    rows = [row for row in csv.reader(stdout.splitlines()) if row]
    processes: list[dict[str, Any]] = []
    for row in rows:
        if not row:
            continue
        if len(row) < 3:
            continue
        try:
            pid = int(row[0].strip())
        except ValueError:
            continue
        if pid <= 1:
            continue
        name = row[1].strip() or f"pid {pid}"
        processes.append(
            {
                "pid": pid,
                "name": name,
                "command": _read_process_command(pid),
                "usedMemoryBytes": parse_mib(row[2]),
                "gpuUuid": row[3].strip() if len(row) > 3 and not row[3].strip().startswith("[") else None,
            }
        )
    processes.sort(key=lambda item: item["pid"])
    return processes, "nvidia-smi", errors


def read_meminfo() -> dict[str, int]:
    values: dict[str, int] = {}
    with open("/proc/meminfo", "r", encoding="utf-8") as handle:
        for line in handle:
            parts = line.split()
            if len(parts) >= 2:
                values[parts[0].rstrip(":")] = int(parts[1]) * 1024
    return values


def read_ram() -> dict[str, Any]:
    values = read_meminfo()
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable")
    if available is None:
        available = values.get("MemFree", 0)
    if total <= 0:
        raise MetricError("/proc/meminfo did not report MemTotal")
    return {
        "totalBytes": total,
        "availableBytes": max(0, available),
        "usedBytes": max(0, total - available),
        "source": "procfs",
    }


def read_swap() -> Optional[dict[str, int]]:
    values = read_meminfo()
    total = values.get("SwapTotal", 0)
    if total <= 0:
        return None
    return {"totalBytes": total, "freeBytes": max(0, values.get("SwapFree", 0))}


def read_disk(path: Path) -> dict[str, Any]:
    result = os.statvfs(path)
    total = result.f_blocks * result.f_frsize
    free = result.f_bavail * result.f_frsize
    used = max(0, (result.f_blocks - result.f_bfree) * result.f_frsize)
    return {
        "path": str(path),
        "totalBytes": total,
        "freeBytes": free,
        "usedBytes": used,
        "source": "statvfs",
    }


def read_cpu() -> dict[str, Any]:
    try:
        count = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        count = os.cpu_count() or 1
    load1, load5, load15 = os.getloadavg()
    return {
        "count": max(1, count),
        "load1": round(load1, 3),
        "load5": round(load5, 3),
        "load15": round(load15, 3),
    }


def _read_temperature_file(path: Path) -> Optional[float]:
    try:
        raw = path.read_text(encoding="utf-8").strip()
        value = float(raw) / 1000.0
    except (OSError, ValueError):
        return None
    if 0 <= value <= 150:
        return value
    return None


def read_cpu_temperature() -> tuple[Optional[float], str]:
    thermal_root = Path("/sys/class/thermal")
    fallback: Optional[float] = None
    try:
        zones = sorted(thermal_root.glob("thermal_zone*"))
    except OSError:
        zones = []
    for zone in zones:
        try:
            zone_type = (zone / "type").read_text(encoding="utf-8").strip().lower()
        except OSError:
            zone_type = ""
        value = _read_temperature_file(zone / "temp")
        if value is None:
            continue
        if any(token in zone_type for token in ("cpu", "soc", "pkg", "core")):
            return value, "thermal_zone"
        if fallback is None:
            fallback = value
    if fallback is not None:
        return fallback, "thermal_zone"
    hwmon_root = Path("/sys/class/hwmon")
    try:
        hwmons = sorted(hwmon_root.glob("hwmon*"))
    except OSError:
        hwmons = []
    for hwmon in hwmons:
        try:
            name = (hwmon / "name").read_text(encoding="utf-8").strip().lower()
        except OSError:
            name = ""
        value = _read_temperature_file(hwmon / "temp1_input")
        if value is None:
            continue
        if any(token in name for token in ("cpu", "core", "pkg", "package")):
            return value, "hwmon"
        if fallback is None:
            fallback = value
    if fallback is not None:
        return fallback, "hwmon"
    return None, "none"


def _dedupe_errors(errors: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for error in errors:
        key = (str(error.get("metric")), str(error.get("message")))
        if key in seen:
            continue
        seen.add(key)
        result.append(error)
    return result


class ProbeState:
    def __init__(self, config: ProbeConfig, logger: logging.Logger) -> None:
        self.config = config
        self.logger = logger
        self.boot_id = str(uuid.uuid4())
        self.vm_boot_id = read_boot_id()
        self.pid = os.getpid()
        self.python = platform.python_version()
        self.started_at_ms = int(time.time() * 1000)
        self.seq = 0
        self.last_sample_at_ms = 0
        self.peaks: dict[int, int] = {}
        self.last_processes: list[dict[str, Any]] = []
        self.stop_event = threading.Event()
        self.metrics_path = config.probe_dir / "metrics.jsonl"
        self.metrics_file = "metrics.jsonl"
        self.results: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
        try:
            self.metrics_path.write_text("", encoding="utf-8")
        except OSError:
            pass

    def build_status(self, state: str) -> dict[str, Any]:
        return {
            "protocol": PROTOCOL,
            "bootId": self.boot_id,
            "vmBootId": self.vm_boot_id,
            "pid": self.pid,
            "python": self.python,
            "startedAtMs": self.started_at_ms,
            "serverNowMs": int(time.time() * 1000),
            "lastSampleAtMs": self.last_sample_at_ms,
            "seq": self.seq,
            "sampleIntervalMs": self.config.interval_ms,
            "probeDir": str(self.config.probe_dir),
            "metricsFile": self.metrics_file,
            "state": state,
            "capabilities": CAPABILITIES,
        }

    def write_status(self, state: str) -> None:
        atomic_write_json(self.config.probe_dir / "status.json", self.build_status(state))

    def append_sample(self, sample: dict[str, Any]) -> None:
        try:
            if self.metrics_path.exists() and self.metrics_path.stat().st_size > self.config.metrics_max_bytes:
                rotated = self.config.probe_dir / "metrics.1.jsonl"
                if rotated.exists():
                    rotated.unlink()
                os.replace(self.metrics_path, rotated)
        except OSError as error:
            self.logger.warning("failed to rotate metrics: %s", error)
        with open(self.metrics_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(sample, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def write_bye(self, reason: str, message: Optional[str]) -> None:
        payload = {
            "type": "BYE",
            "protocol": PROTOCOL,
            "bootId": self.boot_id,
            "reason": reason,
            "message": message,
        }
        try:
            with open(self.metrics_path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, separators=(",", ":")) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as error:
            self.logger.warning("failed to write BYE: %s", error)

    def collect_sample(self) -> dict[str, Any]:
        errors: list[dict[str, Any]] = []
        gpus, gpu_errors = query_gpus(self.config, self.peaks)
        errors.extend(gpu_errors)
        processes, process_source, process_errors = query_gpu_processes(self.config)
        errors.extend(process_errors)
        self.last_processes = processes

        try:
            ram = read_ram()
        except Exception as error:  # noqa: BLE001 - a single metric must not kill the probe
            ram = {"totalBytes": 0, "availableBytes": 0, "usedBytes": 0, "source": "procfs"}
            errors.append({"metric": "ram", "message": str(error)[:500], "recoverable": True})

        try:
            swap = read_swap()
        except Exception as error:  # noqa: BLE001
            swap = None
            errors.append({"metric": "swap", "message": str(error)[:500], "recoverable": True})

        try:
            disk = read_disk(self.config.probe_dir)
        except Exception as error:  # noqa: BLE001
            disk = {
                "path": str(self.config.probe_dir),
                "totalBytes": 0,
                "freeBytes": 0,
                "usedBytes": 0,
                "source": "statvfs",
            }
            errors.append({"metric": "disk", "message": str(error)[:500], "recoverable": True})

        try:
            cpu = read_cpu()
        except Exception as error:  # noqa: BLE001
            cpu = {"count": 1, "load1": 0, "load5": 0, "load15": 0}
            errors.append({"metric": "cpu", "message": str(error)[:500], "recoverable": True})

        try:
            cpu_temperature, temperature_source = read_cpu_temperature()
        except Exception as error:  # noqa: BLE001
            cpu_temperature = None
            temperature_source = "none"
            errors.append({"metric": "temperature", "message": str(error)[:500], "recoverable": True})

        gpu_temperature = None
        for gpu in gpus:
            value = gpu.get("temperatureC")
            if value is not None and (gpu_temperature is None or value > gpu_temperature):
                gpu_temperature = value
        if gpu_temperature is not None:
            temperature_source = "nvidia-smi"

        gpu_group = {
            "present": bool(gpus),
            "source": "nvidia-smi" if gpus else ("procfs" if processes else "none"),
            "gpus": gpus,
            "processes": processes,
        }
        return {
            "type": "SAMPLE",
            "protocol": PROTOCOL,
            "bootId": self.boot_id,
            "seq": self.seq,
            "timestampMs": int(time.time() * 1000),
            "intervalMs": self.config.interval_ms,
            "metrics": {
                "gpu": gpu_group,
                "ram": ram,
                "swap": swap,
                "disk": disk,
                "cpu": cpu,
                "temperature": {
                    "cpuC": cpu_temperature,
                    "gpuC": gpu_temperature,
                    "source": temperature_source,
                },
            },
            "errors": _dedupe_errors(errors),
        }


def _pid_alive(pid: int) -> bool:
    try:
        stat_line = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        if stat_line.rsplit(")", 1)[-1].strip().startswith("Z"):
            return False
    except OSError:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def kill_process(config: ProbeConfig, pid: int) -> dict[str, Any]:
    if pid <= 1 or pid == os.getpid() or pid == os.getppid():
        raise CommandRejected("INVALID_PID", "refusing to kill a protected PID")
    processes, _, _ = query_gpu_processes(config)
    if not any(item["pid"] == pid for item in processes):
        return {
            "kind": "KILL_PROCESS",
            "pid": pid,
            "killed": False,
            "alreadyDead": True,
            "verified": False,
        }
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return {
            "kind": "KILL_PROCESS",
            "pid": pid,
            "killed": False,
            "alreadyDead": True,
            "verified": True,
        }
    except PermissionError as error:
        raise CommandRejected("KILL_REJECTED", f"permission denied: {error}") from error
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and _pid_alive(pid):
        time.sleep(0.1)
    if _pid_alive(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline and _pid_alive(pid):
            time.sleep(0.1)
    alive = _pid_alive(pid)
    return {
        "kind": "KILL_PROCESS",
        "pid": pid,
        "killed": not alive,
        "alreadyDead": False,
        "verified": not alive,
    }


def scan_disk(path: str, max_entries: int, max_depth: int) -> tuple[list[dict[str, Any]], bool]:
    if not os.path.isabs(path):
        raise CommandRejected("INVALID_PATH", "path must be absolute")
    real = os.path.realpath(path)
    allowed = real == "/content" or real.startswith("/content/") or real == "/tmp" or real.startswith("/tmp/")
    if not allowed:
        raise CommandRejected("INVALID_PATH", "only /content and /tmp are allowed")
    if not os.path.exists(real):
        raise CommandRejected("PATH_NOT_FOUND", f"path does not exist: {real}")
    entries: list[dict[str, Any]] = []
    max_entries = max(1, min(1000, max_entries))
    max_depth = max(0, min(16, max_depth))
    for root, dirs, files in os.walk(real, followlinks=False):
        relative = os.path.relpath(root, real)
        depth = 0 if relative == "." else relative.count(os.sep) + 1
        if depth >= max_depth:
            dirs[:] = []
        if depth > max_depth:
            continue
        for name in files:
            full_path = os.path.join(root, name)
            try:
                file_stat = os.lstat(full_path)
                if not stat.S_ISREG(file_stat.st_mode):
                    continue
            except OSError:
                continue
            entries.append({"path": full_path, "bytes": file_stat.st_size, "kind": "file"})
    entries.sort(key=lambda item: item["bytes"], reverse=True)
    return entries[:max_entries], len(entries) > max_entries


def validate_command(raw: Any, now_ms: int, max_age_ms: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise CommandRejected("INVALID_COMMAND", "command must be a JSON object")
    command_type = raw.get("type")
    if not isinstance(command_type, str) or command_type not in COMMAND_TYPES:
        raise CommandRejected("UNKNOWN_COMMAND", f"unknown command type: {command_type}")
    allowed_fields = {"type", "protocol", "requestId", "issuedAtMs"}
    if command_type == "KILL_PROCESS":
        allowed_fields.add("pid")
    elif command_type == "SCAN_DISK":
        allowed_fields.update({"path", "maxEntries", "maxDepth"})
    unknown_fields = sorted(set(raw) - allowed_fields)
    if unknown_fields:
        raise CommandRejected("INVALID_COMMAND", f"unknown fields: {', '.join(unknown_fields)}")
    protocol = raw.get("protocol")
    if isinstance(protocol, bool) or protocol != PROTOCOL:
        raise CommandRejected("PROTOCOL_MISMATCH", "unsupported command protocol")
    request_id = raw.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        raise CommandRejected("INVALID_REQUEST", "requestId must be a non-empty string")
    issued_at = raw.get("issuedAtMs")
    if not isinstance(issued_at, int) or isinstance(issued_at, bool) or issued_at < 0:
        raise CommandRejected("INVALID_REQUEST", "issuedAtMs must be a non-negative integer")
    if now_ms - issued_at > max_age_ms:
        raise CommandRejected("COMMAND_EXPIRED", "command is older than the allowed window")

    command: dict[str, Any] = {
        "type": command_type,
        "protocol": PROTOCOL,
        "requestId": request_id,
        "issuedAtMs": issued_at,
    }
    if command_type == "KILL_PROCESS":
        pid = raw.get("pid")
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            raise CommandRejected("INVALID_PID", "pid must be a positive integer")
        command["pid"] = pid
    elif command_type == "SCAN_DISK":
        path = raw.get("path")
        if not isinstance(path, str) or not path:
            raise CommandRejected("INVALID_PATH", "path must be a non-empty string")
        max_entries = raw.get("maxEntries", 50)
        max_depth = raw.get("maxDepth", 4)
        if not isinstance(max_entries, int) or isinstance(max_entries, bool):
            raise CommandRejected("INVALID_REQUEST", "maxEntries must be an integer")
        if not isinstance(max_depth, int) or isinstance(max_depth, bool):
            raise CommandRejected("INVALID_REQUEST", "maxDepth must be an integer")
        command["path"] = path
        command["maxEntries"] = max(1, min(1000, max_entries))
        command["maxDepth"] = max(0, min(16, max_depth))
    return command


class CommandWorker(threading.Thread):
    def __init__(self, state: ProbeState) -> None:
        super().__init__(name="colabdeck-command-worker", daemon=True)
        self.state = state
        self.config = state.config
        self.logger = state.logger
        self.commands_dir = self.config.probe_dir / "commands"
        self.results_dir = self.config.probe_dir / "results"
        self.commands_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir.mkdir(parents=True, exist_ok=True)

    def run(self) -> None:
        while not self.state.stop_event.is_set():
            try:
                self.scan_once()
            except Exception as error:  # noqa: BLE001 - worker must survive
                self.logger.exception("command worker failed: %s", error)
            self.state.stop_event.wait(0.5)

    def scan_once(self) -> None:
        try:
            command_files = sorted(self.commands_dir.glob("*.json"))
        except OSError as error:
            self.logger.warning("cannot list commands: %s", error)
            return
        for path in command_files:
            if not path.name.endswith(".json") or path.name.endswith(".tmp"):
                continue
            self.handle_file(path)

    def handle_file(self, path: Path) -> None:
        request_id = path.stem
        try:
            raw = read_json(path)
            command = validate_command(raw, int(time.time() * 1000), self.config.command_max_age_ms)
            cached = self.state.results.get(request_id)
            if cached is not None:
                self._write_result(request_id, cached["ok"], cached["result"], cached["error"])
                path.unlink(missing_ok=True)
                return
            if command["type"] == "STOP":
                payload: dict[str, Any] = {"kind": "STOP"}
                self._write_result(request_id, True, payload, None)
                path.unlink(missing_ok=True)
                self.logger.info("STOP command accepted; shutting down")
                self.state.stop_event.set()
                return
            ok, result, error = self.execute(command)
            self.state.results[request_id] = {"ok": ok, "result": result, "error": error}
            while len(self.state.results) > MAX_CACHED_RESULTS:
                self.state.results.popitem(last=False)
            self._write_result(request_id, ok, result, error)
            path.unlink(missing_ok=True)
        except CommandRejected as error:
            self._write_result(request_id, False, None, {"code": error.code, "message": str(error)})
            path.unlink(missing_ok=True)
        except Exception as error:  # noqa: BLE001 - report instead of crashing the worker
            self.logger.exception("command failed: %s", error)
            self._write_result(
                request_id,
                False,
                None,
                {"code": "COMMAND_FAILED", "message": str(error)[:500]},
            )
            path.unlink(missing_ok=True)

    def execute(self, command: dict[str, Any]) -> tuple[bool, Optional[dict[str, Any]], Optional[dict[str, str]]]:
        try:
            if command["type"] == "LIST_GPU_PROCESSES":
                processes, source, errors = query_gpu_processes(self.config)
                self.state.last_processes = processes
                return True, {
                    "kind": "LIST_GPU_PROCESSES",
                    "processes": processes,
                    "source": source,
                    "errors": errors,
                }, None
            if command["type"] == "KILL_PROCESS":
                payload = kill_process(self.config, int(command["pid"]))
                self.logger.info("KILL_PROCESS pid=%s killed=%s verified=%s", payload["pid"], payload["killed"], payload["verified"])
                return True, payload, None
            if command["type"] == "SCAN_DISK":
                entries, truncated = scan_disk(str(command["path"]), int(command["maxEntries"]), int(command["maxDepth"]))
                return True, {
                    "kind": "SCAN_DISK",
                    "path": command["path"],
                    "entries": entries,
                    "truncated": truncated,
                }, None
            if command["type"] == "GET_PROBE_STATUS":
                return True, {"kind": "GET_PROBE_STATUS", "status": self.state.build_status("running")}, None
        except CommandRejected as error:
            return False, None, {"code": error.code, "message": str(error)}
        except Exception as error:  # noqa: BLE001
            self.logger.exception("command execution failed")
            return False, None, {"code": "COMMAND_FAILED", "message": str(error)[:500]}
        return False, None, {"code": "UNKNOWN_COMMAND", "message": "unsupported command"}

    def _write_result(
        self,
        request_id: str,
        ok: bool,
        result: Optional[dict[str, Any]],
        error: Optional[dict[str, str]],
    ) -> None:
        payload = {
            "type": "COMMAND_RESULT",
            "protocol": PROTOCOL,
            "bootId": self.state.boot_id,
            "requestId": request_id,
            "ok": ok,
            "result": result,
            "error": error,
        }
        atomic_write_json(self.results_dir / f"{request_id}.json", payload)


def install_signal_handlers(state: ProbeState) -> None:
    def handler(signum: int, _frame: Any) -> None:
        state.logger.info("received signal %s; stopping", signum)
        state.stop_event.set()

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


def run() -> int:
    config = load_config()
    try:
        config.probe_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print(f"ColabDeck probe: cannot create probe directory: {error}", file=sys.stderr)
        return 1
    logger = setup_logging(config.probe_dir / "probe.log")
    lock = acquire_lock(config.probe_dir / "probe.lock")
    if lock is None:
        logger.info("another probe instance is already running; exiting")
        return 0
    try:
        os.nice(10)
    except OSError:
        pass
    state = ProbeState(config, logger)
    install_signal_handlers(state)
    (config.probe_dir / "probe.pid").write_text(str(state.pid), encoding="utf-8")
    worker = CommandWorker(state)
    worker.start()
    logger.info(
        "probe started bootId=%s pid=%s interval=%sms dir=%s",
        state.boot_id,
        state.pid,
        config.interval_ms,
        config.probe_dir,
    )
    try:
        while not state.stop_event.is_set():
            started = time.monotonic()
            state.seq += 1
            try:
                sample = state.collect_sample()
                state.last_sample_at_ms = sample["timestampMs"]
                state.append_sample(sample)
                state.write_status("running")
            except Exception as error:  # noqa: BLE001 - keep the probe alive
                logger.exception("sample failed: %s", error)
                state.write_status("error")
            elapsed_ms = (time.monotonic() - started) * 1000
            state.stop_event.wait(max(0.05, (config.interval_ms - elapsed_ms) / 1000))
    except KeyboardInterrupt:
        logger.info("keyboard interrupt; stopping")
    finally:
        state.write_bye("stop", "probe stopped")
        try:
            state.write_status("stopping")
        except Exception as error:  # noqa: BLE001
            logger.warning("failed to write final status: %s", error)
        try:
            (config.probe_dir / "probe.pid").unlink(missing_ok=True)
        except OSError:
            pass
        release_lock(lock)
        logger.info("probe stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
