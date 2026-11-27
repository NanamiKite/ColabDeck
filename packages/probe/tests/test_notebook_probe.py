from __future__ import annotations

import ctypes
import json
import os
import re
import runpy
import select
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="notebook sampling requires Linux /proc")

PROBE_PATH = Path(__file__).resolve().parents[1] / "colabdeck_notebook.py"
PR_SET_CHILD_SUBREAPER = 36
PR_GET_CHILD_SUBREAPER = 37
OWNER_SCRIPT = """
import json
import runpy
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding='utf-8')
namespace = {'__name__': 'colabdeck_notebook'}
exec(compile(source, 'colabdeck_notebook.py', 'exec'), namespace)
for line in sys.stdin:
    operation, *args = json.loads(line)
    if operation == 'start':
        result = namespace['start'](*args, source)
        sampler = Path(result) / 'colabdeck_notebook.py'
    else:
        result = runpy.run_path(str(sampler))['read'](*args)
    print(json.dumps(result), flush=True)
"""


@pytest.fixture
def api():
    return runpy.run_path(str(PROBE_PATH))


@pytest.fixture
def kernel(request, tmp_path):
    source_path = PROBE_PATH
    for constant, value in getattr(request, "param", {}).items():
        source = source_path.read_text(encoding="utf-8")
        source, count = re.subn(rf"^{constant} = .+$", f"{constant} = {value}", source, flags=re.MULTILINE)
        assert count == 1
        source_path = tmp_path / PROBE_PATH.name
        source_path.write_text(source, encoding="utf-8")

    libc = ctypes.CDLL(None, use_errno=True)
    previous = ctypes.c_int()
    assert libc.prctl(PR_GET_CHILD_SUBREAPER, ctypes.byref(previous), 0, 0, 0) == 0
    assert libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0
    process = subprocess.Popen(
        [sys.executable, "-u", "-c", OWNER_SCRIPT, str(source_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert process.stdin is not None and process.stdout is not None
    worker_pids: set[int] = set()

    def call(operation: str, *args: object):
        process.stdin.write(json.dumps([operation, *args]) + "\n")
        process.stdin.flush()
        assert select.select([process.stdout], [], [], 5)[0], "notebook owner did not reply"
        reply = json.loads(process.stdout.readline())
        children = Path(f"/proc/{process.pid}/task/{process.pid}/children").read_text()
        worker_pids.update(int(pid) for pid in children.split())
        return reply

    try:
        yield process, call
    finally:
        process.stdin.close()
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        deadline = time.monotonic() + 8
        try:
            for pid in worker_pids:
                while time.monotonic() < deadline:
                    try:
                        finished, _status = os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        break
                    if finished == pid:
                        break
                    time.sleep(0.05)
                else:
                    pytest.fail(f"notebook sampler {pid} did not exit after its owner stopped")
        finally:
            assert libc.prctl(PR_SET_CHILD_SUBREAPER, previous.value, 0, 0, 0) == 0


def wait_until(check, timeout: float = 8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    pytest.fail("notebook sampler did not reach the expected state")


@pytest.mark.parametrize("session_id", ["../outside", "A" * 32, "0" * 31])
def test_rejects_invalid_session_identity(api, session_id: str) -> None:
    with pytest.raises(ValueError):
        api["start"](session_id, 1000, PROBE_PATH.read_text(encoding="utf-8"))
    with pytest.raises(ValueError):
        api["read"](session_id, 0)


@pytest.mark.parametrize("interval_ms", [False, 999, 60_001, "1000"])
def test_rejects_invalid_sample_interval(api, interval_ms: object) -> None:
    with pytest.raises(ValueError):
        api["start"](uuid.uuid4().hex, interval_ms, PROBE_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("after_seq,limit", [(-1, 16), (False, 16), (0, 0), (0, 33)])
def test_rejects_invalid_sync_bounds(api, after_seq: object, limit: int) -> None:
    with pytest.raises(ValueError):
        api["read"](uuid.uuid4().hex, after_seq, limit)


def test_selects_at_most_one_batch_from_the_retained_history(api) -> None:
    select_sequences = api["_sample_sequences"]
    assert list(select_sequences(12, 0, 5, 1)) == [12]
    assert list(select_sequences(12, 0, 5, 3)) == [8, 10, 12]
    assert list(select_sequences(12, 9, 5, 16)) == [10, 11, 12]
    assert list(select_sequences(12, 12, 5, 16)) == []


def test_reuses_session_and_samples_without_notebook_calls(kernel, api) -> None:
    process, call = kernel
    session_id = uuid.uuid4().hex
    directory = Path(call("start", session_id, 1000))
    assert directory.name == session_id
    assert re.fullmatch(rf"/tmp/colabdeck-notebook-{os.getuid()}-{process.pid}-\d+/{session_id}", str(directory))
    assert directory.stat().st_mode & 0o777 == 0o700
    assert Path(call("start", uuid.uuid4().hex, 1000)) == directory
    assert api["read"](session_id, 0) == {"sessionId": session_id, "samples": [], "active": False}

    wait_until(lambda: len(list(directory.glob("sample-*.json"))) >= 2)
    result = call("read", session_id, 0, 1)
    assert set(result) == {"sessionId", "samples", "active"}
    assert result["sessionId"] == session_id and result["active"] is True
    assert len(result["samples"]) == 1
    sample = result["samples"][0]
    assert set(sample) == {"type", "protocol", "bootId", "seq", "timestampMs", "intervalMs", "metrics", "errors"}
    assert sample["type"] == "SAMPLE" and sample["protocol"] == 1
    assert sample["bootId"] == session_id
    assert sample["seq"] >= 2 and sample["intervalMs"] == 1000
    assert sample["metrics"]["gpu"]["processes"] == []
    assert call("read", session_id, 1_000_000, 1)["samples"] == []


def test_removes_session_after_notebook_owner_exits(kernel) -> None:
    process, call = kernel
    directory = Path(call("start", uuid.uuid4().hex, 1000))
    wait_until(lambda: next(directory.glob("sample-*.json"), None))
    process.terminate()
    process.wait(timeout=5)
    wait_until(lambda: not directory.parent.exists())


@pytest.mark.parametrize("kernel", [{"LEASE_SECONDS": 1}, {"MAX_LIFETIME_SECONDS": 1}], indirect=True)
def test_removes_expired_session_without_stopping_notebook_owner(kernel) -> None:
    process, call = kernel
    directory = Path(call("start", uuid.uuid4().hex, 1000))
    wait_until(lambda: not directory.parent.exists())
    assert process.poll() is None
