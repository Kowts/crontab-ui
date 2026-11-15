import contextlib
import errno
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    "native_probe", Path(__file__).resolve().parents[1] / "scripts" / "native-execution-probe.py"
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class NativeProbeTests(unittest.TestCase):
    def test_refuses_direct_execution_before_allocating_or_spawning(self):
        with patch.object(probe.sys, "platform", "linux"), \
                patch.object(probe.os, "getuid", return_value=1001, create=True), \
                patch.object(probe.Path, "cwd", return_value=probe.FIXTURE_ROOT), \
                patch.object(probe.Path, "read_text", return_value="0::/user.slice/unrelated"), \
                patch.object(probe, "child_process") as child, \
                patch.object(probe, "bytearray", create=True) as allocation:
            for mode in ("memory", "pids", "descendants", "cpu"):
                with self.assertRaisesRegex(RuntimeError, "validation service"):
                    probe.run_probe(mode)
            child.assert_not_called()
            allocation.assert_not_called()

    def test_refuses_root_and_non_linux_execution(self):
        for platform, uid in (("win32", 1001), ("linux", 0)):
            with patch.object(probe.sys, "platform", platform), \
                    patch.object(probe.os, "getuid", return_value=uid, create=True), \
                    patch.object(probe.Path, "read_text") as read:
                with self.assertRaisesRegex(RuntimeError, "non-root Linux"):
                    probe.inspect_environment()
                read.assert_not_called()

    def test_refuses_unbounded_limits_even_inside_validation_service(self):
        membership = (
            "0::/system.slice/crontab-ui-validation.service/"
            "execution-629e3f28-dd20-48cc-8a82-2dbc72c91d13"
        )
        for limits in (["max"], ["67108864", "max 100000"], ["67108864", "25000 100000", "max"]):
            with patch.object(probe.sys, "platform", "linux"), \
                    patch.object(probe.os, "getuid", return_value=1001, create=True), \
                    patch.object(probe.Path, "cwd", return_value=probe.FIXTURE_ROOT), \
                    patch.object(probe.Path, "read_text", side_effect=[membership, *limits]):
                with self.assertRaisesRegex(RuntimeError, "Probe requires"):
                    probe.inspect_environment()

    def test_pid_denial_requires_kernel_counter_and_reaps_owned_children(self):
        for after, should_pass in ((1, True), (0, False)):
            child = Mock()
            child.pid = 12345
            child.poll.return_value = None
            with patch.object(probe, "inspect_environment", return_value=Path("/mock")), \
                    patch.object(probe, "counters", side_effect=[{"max": 0}, {"max": after}]), \
                    patch.object(probe, "child_process", side_effect=[child, OSError(errno.EAGAIN, "limit")]), \
                    contextlib.redirect_stdout(io.StringIO()):
                if should_pass:
                    probe.run_probe("pids")
                else:
                    with self.assertRaisesRegex(RuntimeError, "did not increment"):
                        probe.run_probe("pids")
            child.kill.assert_called_once()
            child.wait.assert_called_once_with(timeout=2)

    def test_cpu_evidence_fails_when_measured_usage_exceeds_tolerance(self):
        with patch.object(probe, "inspect_environment", return_value=Path("/mock")), \
                patch.object(probe, "counters", side_effect=[{"usage_usec": 0}, {"usage_usec": 10_000_000}]), \
                patch.object(probe.time, "monotonic", side_effect=[0, 10, 10]), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "exceeds quota"):
                probe.run_probe("cpu")


if __name__ == "__main__":
    unittest.main()
