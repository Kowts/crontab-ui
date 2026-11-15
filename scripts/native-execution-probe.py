"""Bounded probes for the independent Native Linux release drill."""

import argparse
import errno
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


FIXTURE_ROOT = Path("/opt/crontab-ui-validation-fixtures")
MEMBERSHIP = re.compile(
    r"0::(/system\.slice/crontab-ui-validation\.service/execution-"
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"
)


def emit(**fields):
    print(json.dumps(fields, sort_keys=True), flush=True)


def inspect_environment():
    if sys.platform != "linux" or os.getuid() == 0:
        raise RuntimeError("Probe requires non-root Linux execution")
    if Path.cwd() != FIXTURE_ROOT:
        raise RuntimeError("Probe requires the independent validation fixture directory")
    match = MEMBERSHIP.fullmatch(Path("/proc/self/cgroup").read_text().strip())
    if not match:
        raise RuntimeError("Probe requires the independent delegated validation service")
    cgroup = Path("/sys/fs/cgroup") / match.group(1).lstrip("/")
    if (cgroup / "memory.max").read_text().strip() != "67108864":
        raise RuntimeError("Probe requires memory.max=67108864")
    if (cgroup / "cpu.max").read_text().strip() != "25000 100000":
        raise RuntimeError("Probe requires cpu.max='25000 100000'")
    if (cgroup / "pids.max").read_text().strip() != "8":
        raise RuntimeError("Probe requires pids.max=8")
    emit(
        phase="ready", pid=os.getpid(), uid=os.getuid(), python=sys.executable,
        cwd=str(Path.cwd()), cgroup=match.group(1),
        operation_id=cgroup.name.removeprefix("execution-"),
        memory_max=67108864, cpu_max="25000 100000", pids_max=8,
    )
    return cgroup


def counters(filename):
    return {
        key: int(value)
        for key, value in (line.split() for line in filename.read_text().splitlines())
    }


def child_process(ignore_term=False):
    code = "import time; time.sleep(20)"
    if ignore_term:
        code = "import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); " + code
    return subprocess.Popen(
        [sys.executable, "-c", code], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )


def run_probe(mode):
    cgroup = inspect_environment()
    if mode == "baseline":
        emit(phase="completed", mode=mode)
    elif mode == "wait":
        time.sleep(20)
        emit(phase="completed", mode=mode)
    elif mode in ("descendants", "parent-exit"):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = child_process(ignore_term=True)
        time.sleep(0.5)
        emit(phase="child_started", mode=mode, child_pid=child.pid)
        if mode == "descendants":
            time.sleep(20)
            child.wait(timeout=2)
        # parent-exit deliberately leaves a bounded child for executor cleanup.
    elif mode == "cpu":
        before = counters(cgroup / "cpu.stat")["usage_usec"]
        start = time.monotonic()
        while time.monotonic() - start < 10:
            pass
        elapsed = time.monotonic() - start
        used = (counters(cgroup / "cpu.stat")["usage_usec"] - before) / 1_000_000
        maximum = elapsed * 0.25 * 1.25 + 0.25
        emit(phase="completed", mode=mode, elapsed_seconds=elapsed,
             cpu_seconds=used, maximum_cpu_seconds=maximum)
        if used > maximum:
            raise RuntimeError("Observed CPU use exceeds quota tolerance")
    elif mode == "memory":
        time.sleep(5)
        allocations = []
        for _ in range(48):
            chunk = bytearray(2 * 1024 * 1024)
            for offset in range(0, len(chunk), 4096):
                chunk[offset] = 1
            allocations.append(chunk)
        emit(phase="allocation_survived", mode=mode, allocated_bytes=96 * 1024 * 1024)
        raise RuntimeError("OOM was not demonstrated; inspect memory.events and swap policy")
    elif mode == "pids":
        children = []
        before = counters(cgroup / "pids.events")["max"]
        try:
            for _ in range(10):
                try:
                    children.append(child_process())
                except OSError as error:
                    if error.errno != errno.EAGAIN:
                        raise
                    after = counters(cgroup / "pids.events")["max"]
                    emit(phase="limit_rejected", mode=mode, errno=error.errno,
                         child_pids=[child.pid for child in children],
                         pids_max_events_before=before, pids_max_events_after=after)
                    if after <= before:
                        raise RuntimeError("PID denial did not increment the cgroup counter")
                    return
            raise RuntimeError("The configured PID limit did not reject a bounded spawn")
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode", choices=["baseline", "wait", "descendants", "parent-exit", "cpu", "memory", "pids"]
    )
    args = parser.parse_args()
    try:
        run_probe(args.mode)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        emit(phase="failed", mode=args.mode, error=str(error))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
