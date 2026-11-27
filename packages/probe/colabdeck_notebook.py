from __future__ import annotations

import csv
import fcntl
import json
import math
import os
import re
import signal
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable

PROTOCOL = 1
MIN_INTERVAL_MS = 1000
MAX_INTERVAL_MS = 60_000
DEFAULT_INTERVAL_MS = 5000
MAX_BATCH = 32
MAX_SAMPLE_BYTES = 3072
MAX_SOURCE_BYTES = 768 * 1024
LEASE_SECONDS = 60 * 60
MAX_LIFETIME_SECONDS = 6 * 60 * 60
OWNER_CHECK_SECONDS = 1
WORKER_START_GRACE_SECONDS = 5
SLOT_SECONDS = 60 * 60
ROOT_PREFIX = "colabdeck-notebook-"
SESSION_PATTERN = re.compile(r"[0-9a-f]{32}\Z")
ROOT_PATTERN = re.compile(r"colabdeck-notebook-(\d+)-(\d+)-(\d+)\Z")
NVIDIA_SMI_TIMEOUT_SECONDS = 2.0


def _valid_session(value: Any) -> bool:
    return isinstance(value, str) and SESSION_PATTERN.fullmatch(value) is not None


def _validate_session(value: Any) -> str:
    if not _valid_session(value):
        raise ValueError("session_id must be 32 lowercase hexadecimal characters")
    return value


def _validate_interval(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not MIN_INTERVAL_MS <= value <= MAX_INTERVAL_MS:
        raise ValueError(f"interval_ms must be between {MIN_INTERVAL_MS} and {MAX_INTERVAL_MS}")
    return value


def _validate_bounds(after_seq: Any, limit: Any) -> tuple[int, int]:
    if isinstance(after_seq, bool) or not isinstance(after_seq, int) or after_seq < 0:
        raise ValueError("after_seq must be a non-negative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_BATCH:
        raise ValueError(f"limit must be between 1 and {MAX_BATCH}")
    return after_seq, limit


def _pid_start_ticks(pid: int) -> int | None:
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        return None
    tail = text.rsplit(")", 1)[-1].split()
    if len(tail) <= 19:
        return None
    try:
        return int(tail[19])
    except ValueError:
        return None


def _owner_identity() -> tuple[int, int, int]:
    uid = os.getuid() if hasattr(os, "getuid") else 0
    pid = os.getpid()
    start_ticks = _pid_start_ticks(pid)
    if start_ticks is None:
        raise RuntimeError("cannot determine notebook process identity")
    return uid, pid, start_ticks


def _pid_matches(pid: Any, start_ticks: Any) -> bool:
    if isinstance(pid, bool) or not isinstance(pid, int) or isinstance(start_ticks, bool) or not isinstance(start_ticks, int):
        return False
    return _pid_start_ticks(pid) == start_ticks


def _root_for(uid: int, pid: int, start_ticks: int) -> Path:
    return Path("/tmp") / f"{ROOT_PREFIX}{uid}-{pid}-{start_ticks}"


def _session_dir(root: Path, session_id: str) -> Path:
    return root / session_id


def _atomic_json(path: Path, payload: Any) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    with open(temporary, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _read_json(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _manifest(root: Path) -> dict[str, Any] | None:
    try:
        value = _read_json(root / "active.json")
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(value, dict):
        return None
    return value


def _manifest_matches_owner(manifest: dict[str, Any], uid: int, pid: int, start_ticks: int) -> bool:
    return (
        manifest.get("uid") == uid
        and manifest.get("ownerPid") == pid
        and manifest.get("ownerStartTicks") == start_ticks
        and isinstance(manifest.get("sessionId"), str)
        and _valid_session(manifest["sessionId"])
    )


def _worker_matches(manifest: dict[str, Any]) -> bool:
    return _pid_matches(manifest.get("workerPid"), manifest.get("workerStartTicks"))


def _request_stop(root: Path) -> None:
    manifest = _manifest(root)
    if manifest is not None and _worker_matches(manifest):
        try:
            os.kill(int(manifest["workerPid"]), signal.SIGTERM)
        except (OSError, ValueError, TypeError):
            pass
    try:
        _atomic_json(root / "stop.json", {"requestedAt": time.time()})
    except OSError:
        return


def _cleanup_root(root: Path) -> None:
    try:
        shutil.rmtree(root)
    except FileNotFoundError:
        return
    except OSError:
        return


def _roots_for_owner(uid: int, pid: int, start_ticks: int) -> Iterable[Path]:
    parent = Path("/tmp")
    pattern = f"{ROOT_PREFIX}{uid}-{pid}-{start_ticks}"
    try:
        candidates = parent.glob(pattern)
    except OSError:
        return ()
    return (candidate for candidate in candidates if candidate.is_dir() and ROOT_PATTERN.fullmatch(candidate.name))


def _find_session(uid: int, pid: int, start_ticks: int) -> tuple[Path, dict[str, Any]] | None:
    for root in _roots_for_owner(uid, pid, start_ticks):
        manifest = _manifest(root)
        if manifest is None or not _manifest_matches_owner(manifest, uid, pid, start_ticks):
            continue
        if manifest.get("workerPid") == 0 and time.time() - float(manifest.get("createdAt", 0)) < WORKER_START_GRACE_SECONDS:
            session_id = manifest["sessionId"]
            directory = _session_dir(root, session_id)
            if directory.is_dir():
                return directory, manifest
        if not _worker_matches(manifest):
            _cleanup_root(root)
            continue
        session_id = manifest["sessionId"]
        directory = _session_dir(root, session_id)
        if directory.is_dir():
            return directory, manifest
    return None


def _new_root(uid: int, pid: int, start_ticks: int) -> Path:
    root = _root_for(uid, pid, start_ticks)
    try:
        root.mkdir(mode=0o700, parents=False, exist_ok=False)
    except FileExistsError:
        deadline = time.monotonic() + WORKER_START_GRACE_SECONDS
        while time.monotonic() < deadline:
            manifest = _manifest(root)
            if manifest is not None and _manifest_matches_owner(manifest, uid, pid, start_ticks):
                existing_session = manifest.get("sessionId")
                if isinstance(existing_session, str) and _valid_session(existing_session) and _session_dir(root, existing_session).is_dir():
                    return root
            time.sleep(0.01)
        found = _find_session(uid, pid, start_ticks)
        if found is not None:
            return found[0].parent
        _cleanup_root(root)
        root.mkdir(mode=0o700, parents=False, exist_ok=False)
    os.chmod(root, 0o700)
    return root


def _lock_root(root: Path) -> int:
    descriptor = os.open(root / "worker.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(descriptor)
        raise
    return descriptor


def _copy_source(directory: Path, source: str) -> None:
    if not isinstance(source, str) or not source or len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise ValueError("source must be a bounded non-empty Python source string")
    path = directory / "colabdeck_notebook.py"
    temporary = directory / f".source.{os.getpid()}.tmp"
    with open(temporary, "wb") as handle:
        handle.write(source.encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def _new_manifest(uid: int, pid: int, start_ticks: int, session_id: str, interval_ms: int, now: float) -> dict[str, Any]:
    return {
        "uid": uid,
        "ownerPid": pid,
        "ownerStartTicks": start_ticks,
        "workerPid": 0,
        "workerStartTicks": 0,
        "sessionId": session_id,
        "intervalMs": interval_ms,
        "createdAt": now,
        "leaseUntil": now + LEASE_SECONDS,
        "expiresAt": now + MAX_LIFETIME_SECONDS,
    }


def _write_manifest(root: Path, manifest: dict[str, Any]) -> None:
    _atomic_json(root / "active.json", manifest)


def _renew_manifest(root: Path, manifest: dict[str, Any], now: float) -> None:
    expires_at = float(manifest.get("expiresAt", now))
    manifest["leaseUntil"] = min(expires_at, now + LEASE_SECONDS)
    _write_manifest(root, manifest)


def _slot_count(interval_ms: int) -> int:
    return max(8, min(3600, math.ceil(SLOT_SECONDS * 1000 / interval_ms)))


def _sample_sequences(last_seq: int, after_seq: int, retained_count: int, limit: int) -> list[int]:
    if last_seq <= 0 or retained_count <= 0 or limit <= 0:
        return []
    first_seq = max(1, last_seq - retained_count + 1, after_seq + 1)
    if first_seq > last_seq:
        return []
    count = last_seq - first_seq + 1
    if count <= limit:
        return list(range(first_seq, last_seq + 1))
    if limit == 1:
        return [last_seq]
    return [first_seq + round(index * (count - 1) / (limit - 1)) for index in range(limit)]


def _write_cursor(directory: Path, seq: int, slot_count: int, sample_at_ms: int) -> None:
    _atomic_json(
        directory / "cursor.json",
        {"lastSeq": seq, "slotCount": slot_count, "lastSampleAtMs": sample_at_ms},
    )


def _read_cursor(directory: Path) -> dict[str, int] | None:
    try:
        cursor = _read_json(directory / "cursor.json")
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(cursor, dict):
        return None
    values = {key: cursor.get(key) for key in ("lastSeq", "slotCount", "lastSampleAtMs")}
    if not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in values.values()):
        return None
    return values  # type: ignore[return-value]


def _run_nvidia_smi() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=NVIDIA_SMI_TIMEOUT_SECONDS,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as error:
        return [], [{"metric": "gpu", "message": str(error)[:500], "recoverable": True}]
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        return [], [{"metric": "gpu", "message": (detail[0] if detail else "nvidia-smi failed")[:500], "recoverable": True}]
    gpus: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for row in csv.reader(completed.stdout.splitlines()):
        if len(row) < 7:
            continue
        try:
            index = int(row[0].strip())
        except ValueError:
            continue
        values = [row[position].strip() for position in range(1, 7)]
        name = values[0][:120] or "GPU"
        gpus.append(
            {
                "index": index,
                "name": name,
                "utilizationPct": _number(values[1], 0, 100),
                "memoryUsedBytes": _mib(values[2]),
                "memoryTotalBytes": _mib(values[3]),
                "memoryPeakBytes": None,
                "temperatureC": _number(values[4], 0, 150),
                "powerWatts": _number(values[5], 0, None),
            }
        )
    if not gpus and completed.stdout.strip():
        errors.append({"metric": "gpu", "message": "nvidia-smi returned no usable GPU rows", "recoverable": True})
    return gpus, errors


def _number(value: str, minimum: float, maximum: float | None) -> float | None:
    if value.strip() in {"", "N/A", "[N/A]", "[Not Supported]", "-", "NaN"}:
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    if not math.isfinite(number) or number < minimum or maximum is not None and number > maximum:
        return None
    return number


def _mib(value: str) -> int | None:
    number = _number(value, 0, None)
    return None if number is None else int(number * 1024 * 1024)


def _meminfo() -> dict[str, int]:
    result: dict[str, int] = {}
    try:
        lines = Path("/proc/meminfo").read_text(encoding="utf-8").splitlines()
    except OSError:
        return result
    for line in lines:
        fields = line.split()
        if len(fields) >= 2:
            try:
                result[fields[0].rstrip(":")] = int(fields[1]) * 1024
            except ValueError:
                continue
    return result


def _read_ram() -> dict[str, Any]:
    values = _meminfo()
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", values.get("MemFree", 0))
    return {"totalBytes": total, "availableBytes": max(0, available), "usedBytes": max(0, total - available), "source": "procfs"}


def _read_swap() -> dict[str, int] | None:
    values = _meminfo()
    total = values.get("SwapTotal", 0)
    return None if total <= 0 else {"totalBytes": total, "freeBytes": max(0, values.get("SwapFree", 0))}


def _read_cpu() -> dict[str, Any]:
    try:
        count = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        count = os.cpu_count() or 1
    try:
        load1, load5, load15 = os.getloadavg()
    except OSError:
        load1 = load5 = load15 = 0.0
    return {"count": max(1, count), "load1": max(0.0, round(load1, 3)), "load5": max(0.0, round(load5, 3)), "load15": max(0.0, round(load15, 3))}


def _temperature_file(path: Path) -> float | None:
    try:
        value = float(path.read_text(encoding="utf-8").strip()) / 1000
    except (OSError, ValueError):
        return None
    return value if 0 <= value <= 150 else None


def _read_temperature() -> tuple[float | None, str]:
    fallback: float | None = None
    try:
        zones = sorted(Path("/sys/class/thermal").glob("thermal_zone*"))
    except OSError:
        zones = []
    for zone in zones:
        try:
            zone_type = (zone / "type").read_text(encoding="utf-8").strip().lower()
        except OSError:
            zone_type = ""
        value = _temperature_file(zone / "temp")
        if value is None:
            continue
        if any(token in zone_type for token in ("cpu", "soc", "pkg", "core")):
            return value, "thermal_zone"
        fallback = fallback if fallback is not None else value
    return (fallback, "thermal_zone") if fallback is not None else (None, "none")


def _collect(directory: Path, session_id: str, seq: int, interval_ms: int, peaks: dict[int, int]) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    gpus, gpu_errors = _run_nvidia_smi()
    errors.extend(gpu_errors)
    for gpu in gpus:
        index = int(gpu["index"])
        used = gpu["memoryUsedBytes"]
        if used is not None:
            peaks[index] = max(peaks.get(index, 0), used)
            gpu["memoryPeakBytes"] = peaks[index]
    cpu_temperature, temperature_source = _read_temperature()
    gpu_temperature = max((gpu["temperatureC"] for gpu in gpus if gpu["temperatureC"] is not None), default=None)
    if gpu_temperature is not None:
        temperature_source = "nvidia-smi"
    now = int(time.time() * 1000)
    return {
        "type": "SAMPLE",
        "protocol": PROTOCOL,
        "bootId": session_id,
        "seq": seq,
        "timestampMs": now,
        "intervalMs": interval_ms,
        "metrics": {
            "gpu": {"present": bool(gpus), "source": "nvidia-smi" if gpus else "none", "gpus": gpus, "processes": []},
            "ram": _read_ram(),
            "swap": _read_swap(),
            "disk": _read_disk(directory),
            "cpu": _read_cpu(),
            "temperature": {"cpuC": cpu_temperature, "gpuC": gpu_temperature, "source": temperature_source},
        },
        "errors": errors,
    }


def _read_disk(directory: Path) -> dict[str, Any]:
    try:
        stat = os.statvfs(directory)
        total = stat.f_blocks * stat.f_frsize
        free = stat.f_bavail * stat.f_frsize
        used = max(0, (stat.f_blocks - stat.f_bfree) * stat.f_frsize)
    except OSError:
        total = free = used = 0
    return {"path": str(directory), "totalBytes": total, "freeBytes": free, "usedBytes": used, "source": "statvfs"}


def _write_sample(directory: Path, sample: dict[str, Any], slot_count: int) -> None:
    data = json.dumps(sample, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(data) > MAX_SAMPLE_BYTES:
        sample["metrics"]["gpu"]["gpus"] = []
        sample["errors"].append({"metric": "gpu", "message": "sample exceeded size limit", "recoverable": True})
        data = json.dumps(sample, separators=(",", ":"), sort_keys=True).encode("utf-8")
    slot = int(sample["seq"]) % slot_count
    path = directory / f"sample-{slot:04d}.json"
    temporary = directory / f".sample-{slot:04d}.{os.getpid()}.tmp"
    with open(temporary, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    _write_cursor(directory, int(sample["seq"]), slot_count, int(sample["timestampMs"]))


def _worker_main(root: Path, directory: Path, manifest: dict[str, Any]) -> None:
    lock: int | None = None
    try:
        lock = _lock_root(root)
    except OSError:
        return
    worker_pid = os.getpid()
    worker_start = _pid_start_ticks(worker_pid) or 0
    manifest["workerPid"] = worker_pid
    manifest["workerStartTicks"] = worker_start
    try:
        signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(0))
        signal.signal(signal.SIGINT, lambda _signum, _frame: sys.exit(0))
        _write_manifest(root, manifest)
        os.setsid()
    except (OSError, PermissionError):
        pass
    try:
        for descriptor in (0, 1, 2):
            try:
                os.close(descriptor)
            except OSError:
                pass
        interval_ms = int(manifest["intervalMs"])
        session_id = str(manifest["sessionId"])
        slot_count = _slot_count(interval_ms)
        peaks: dict[int, int] = {}
        sequence = 0
        last_owner_check = 0.0
        while True:
            now = time.time()
            if root.joinpath("stop.json").exists() or now >= float(manifest["expiresAt"]) or now >= float(manifest["leaseUntil"]):
                break
            if now - last_owner_check >= OWNER_CHECK_SECONDS:
                last_owner_check = now
                latest_manifest = _manifest(root)
                if latest_manifest is None or latest_manifest.get("sessionId") != manifest.get("sessionId"):
                    break
                manifest = latest_manifest
                if os.getppid() != int(manifest["ownerPid"]) or not _pid_matches(manifest["ownerPid"], manifest["ownerStartTicks"]):
                    break
            sequence += 1
            try:
                sample = _collect(directory, session_id, sequence, interval_ms, peaks)
                _write_sample(directory, sample, slot_count)
            except Exception as error:
                sequence = max(0, sequence - 1)
                error_sample = _collect_fallback(directory, session_id, sequence + 1, interval_ms, str(error))
                sequence += 1
                _write_sample(directory, error_sample, slot_count)
            remaining = interval_ms / 1000
            end = time.monotonic() + remaining
            while time.monotonic() < end:
                if root.joinpath("stop.json").exists() or os.getppid() != int(manifest["ownerPid"]):
                    return
                time.sleep(min(0.25, end - time.monotonic()))
    finally:
        if lock is not None:
            try:
                fcntl.flock(lock, fcntl.LOCK_UN)
                os.close(lock)
            except OSError:
                pass
        _cleanup_root(root)
        os._exit(0)


def _collect_fallback(directory: Path, session_id: str, seq: int, interval_ms: int, message: str) -> dict[str, Any]:
    now = int(time.time() * 1000)
    return {
        "type": "SAMPLE",
        "protocol": PROTOCOL,
        "bootId": session_id,
        "seq": seq,
        "timestampMs": now,
        "intervalMs": interval_ms,
        "metrics": {
            "gpu": {"present": False, "source": "none", "gpus": [], "processes": []},
            "ram": {"totalBytes": 0, "availableBytes": 0, "usedBytes": 0, "source": "procfs"},
            "swap": None,
            "disk": _read_disk(directory),
            "cpu": {"count": 1, "load1": 0, "load5": 0, "load15": 0},
            "temperature": {"cpuC": None, "gpuC": None, "source": "none"},
        },
        "errors": [{"metric": "gpu", "message": message[:500], "recoverable": True}],
    }


def start(session_id: str, interval_ms: int = DEFAULT_INTERVAL_MS, source: str = "") -> str:
    session_id = _validate_session(session_id)
    interval_ms = _validate_interval(interval_ms)
    if not isinstance(source, str) or not source or len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise ValueError("source must be a bounded non-empty Python source string")
    uid, pid, start_ticks = _owner_identity()
    existing = _find_session(uid, pid, start_ticks)
    now = time.time()
    if existing is not None:
        directory, manifest = existing
        manifest["leaseUntil"] = min(float(manifest["expiresAt"]), now + LEASE_SECONDS)
        _write_manifest(directory.parent, manifest)
        return str(directory)
    root = _new_root(uid, pid, start_ticks)
    root_manifest = _manifest(root)
    if root_manifest is not None and _manifest_matches_owner(root_manifest, uid, pid, start_ticks):
        existing_session = root_manifest.get("sessionId")
        if isinstance(existing_session, str) and _valid_session(existing_session):
            existing_directory = _session_dir(root, existing_session)
            if existing_directory.is_dir():
                return str(existing_directory)
    directory = _session_dir(root, session_id)
    directory.mkdir(mode=0o700, exist_ok=False)
    os.chmod(directory, 0o700)
    _copy_source(directory, source)
    manifest = _new_manifest(uid, pid, start_ticks, session_id, interval_ms, now)
    _write_manifest(root, manifest)
    try:
        child_process = subprocess.Popen(
            [sys.executable, str(directory / "colabdeck_notebook.py"), "--worker", str(root), str(directory)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
    except OSError:
        _cleanup_root(root)
        raise
    worker_start: int | None = None
    deadline = time.monotonic() + 1
    while worker_start is None and time.monotonic() < deadline:
        worker_start = _pid_start_ticks(child_process.pid)
        if worker_start is None:
            time.sleep(0.01)
    if worker_start is not None:
        manifest["workerPid"] = child_process.pid
        manifest["workerStartTicks"] = worker_start
        _write_manifest(root, manifest)
    return str(directory)


def _read_samples(directory: Path, cursor: dict[str, int], session_id: str, after_seq: int, limit: int) -> list[dict[str, Any]]:
    sequences = _sample_sequences(cursor["lastSeq"], after_seq, cursor["slotCount"], limit)
    samples: list[dict[str, Any]] = []
    for sequence in sequences:
        slot = sequence % cursor["slotCount"]
        path = directory / f"sample-{slot:04d}.json"
        try:
            sample = _read_json(path)
        except (OSError, ValueError, TypeError):
            continue
        if isinstance(sample, dict) and sample.get("bootId") == session_id and sample.get("seq") == sequence:
            samples.append(sample)
    return samples


def read(session_id: str, after_seq: int = 0, limit: int = 16) -> dict[str, Any]:
    session_id = _validate_session(session_id)
    after_seq, limit = _validate_bounds(after_seq, limit)
    try:
        uid, pid, start_ticks = _owner_identity()
    except RuntimeError:
        return {"sessionId": session_id, "samples": [], "active": False}
    found = _find_session(uid, pid, start_ticks)
    if found is None:
        return {"sessionId": session_id, "samples": [], "active": False}
    directory, manifest = found
    if manifest.get("sessionId") != session_id or not _worker_matches(manifest):
        return {"sessionId": session_id, "samples": [], "active": False}
    now = time.time()
    if now >= float(manifest.get("expiresAt", 0)):
        _request_stop(directory.parent)
        return {"sessionId": session_id, "samples": [], "active": False}
    _renew_manifest(directory.parent, manifest, now)
    cursor = _read_cursor(directory)
    if cursor is None:
        return {"sessionId": session_id, "samples": [], "active": True}
    return {"sessionId": session_id, "samples": _read_samples(directory, cursor, session_id, after_seq, limit), "active": True}


def stop(session_id: str) -> dict[str, Any]:
    session_id = _validate_session(session_id)
    try:
        uid, pid, start_ticks = _owner_identity()
    except RuntimeError:
        return {"sessionId": session_id, "stopped": False}
    found = _find_session(uid, pid, start_ticks)
    if found is None:
        return {"sessionId": session_id, "stopped": False}
    directory, manifest = found
    if manifest.get("sessionId") != session_id or not _worker_matches(manifest):
        return {"sessionId": session_id, "stopped": False}
    _request_stop(directory.parent)
    return {"sessionId": session_id, "stopped": True}


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "--worker":
        raise SystemExit(2)
    worker_root = Path(sys.argv[2])
    worker_directory = Path(sys.argv[3])
    worker_manifest = _manifest(worker_root)
    if worker_manifest is None:
        raise SystemExit(1)
    _worker_main(worker_root, worker_directory, worker_manifest)
