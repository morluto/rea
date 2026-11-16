#!/usr/bin/env python3
"""Persistent interactive LLDB session daemon for REA on macOS Apple Silicon.

Contributed by Hardik Shah <hardik05@gmail.com> (https://fuzzing.in, @hardik05).

Owns an active LLDB SBDebugger instance and serves JSON-RPC line-delimited
commands over standard input/output. Manages native Mach-O targets, ARM64/PAC
register inspection, Objective-C/Swift expression evaluation, breakpoint
trapping, and process lifecycle with strict timeout boundaries.
"""

import sys
import os
import json
import signal
import errno
import fcntl
import select
import threading
import traceback

# Ensure Xcode / Developer Tools LLDB Python bindings are discoverable
XCODE_LLDB_PATHS = [
    "/Volumes/MyData/Applications/Xcode-26.6.0.app/Contents/SharedFrameworks/LLDB.framework/Resources/Python",
    "/Applications/Xcode.app/Contents/SharedFrameworks/LLDB.framework/Resources/Python",
    "/Library/Developer/CommandLineTools/Library/PrivateFrameworks/LLDB.framework/Resources/Python",
]

for p in XCODE_LLDB_PATHS:
    if os.path.exists(p) and p not in sys.path:
        sys.path.insert(0, p)
        break

try:
    import lldb
except ImportError:
    # Allow fallback if invoked via python wrapper with PYTHONPATH already set
    pass


class _BoundedPipeCapture:
    """Drain immediate command output in-flight while bounding memory and avoiding disk files."""

    def __init__(self, max_bytes: int):
        self.max_bytes = max_bytes
        self.r_fd, self.w_fd = os.pipe()
        flags = fcntl.fcntl(self.r_fd, fcntl.F_GETFL)
        fcntl.fcntl(self.r_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        self.captured_bytes = bytearray()
        self.truncated = False
        self.stop_reader = threading.Event()
        self.thread = threading.Thread(target=self._reader_loop, daemon=True)
        self.thread.start()

    def _drain(self, max_pass: int = 65536) -> int:
        consumed = 0
        while consumed < max_pass:
            try:
                chunk = os.read(self.r_fd, min(65536, max_pass - consumed))
            except OSError as error:
                if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    return consumed
                return consumed
            if not chunk:
                return consumed
            consumed += len(chunk)
            remaining = max(0, self.max_bytes - len(self.captured_bytes))
            if remaining:
                self.captured_bytes.extend(chunk[:remaining])
            if len(chunk) > remaining:
                self.truncated = True
        return consumed

    def _reader_loop(self):
        while not self.stop_reader.is_set():
            try:
                readable, _, _ = select.select([self.r_fd], [], [], 0.05)
                if readable:
                    self._drain()
            except Exception:
                break

    def finish(self, timeout: float = 0.5) -> tuple[str, bool]:
        self.stop_reader.set()
        if self.w_fd is not None:
            try:
                os.close(self.w_fd)
            except OSError:
                pass
            self.w_fd = None
        if self.thread is not None:
            self.thread.join(timeout=timeout)
        try:
            self._drain()
        except Exception:
            pass
        if self.r_fd is not None:
            try:
                os.close(self.r_fd)
            except OSError:
                pass
            self.r_fd = None
        return self.captured_bytes.decode("utf-8", errors="replace"), self.truncated

    def close(self):
        self.stop_reader.set()
        if self.w_fd is not None:
            try:
                os.close(self.w_fd)
            except OSError:
                pass
            self.w_fd = None
        if self.r_fd is not None:
            try:
                os.close(self.r_fd)
            except OSError:
                pass
            self.r_fd = None


class ReaLldbSessionDaemon:
    """Manages one persistent LLDB debugging session over stdio JSON-RPC."""

    MAX_OUTPUT_CHARS = 2 * 1024 * 1024
    MAX_MEMORY_READ_BYTES = 1048576  # Bound native allocations before costly read operations

    def __init__(self):
        if "lldb" not in sys.modules or not hasattr(lldb, "SBDebugger"):
            raise RuntimeError("LLDB Python framework is unavailable.")
        lldb.SBDebugger.Initialize()
        self.debugger = lldb.SBDebugger.Create()
        self.debugger.SetAsync(False)
        # Impose bounds on native allocations before large reads can exhaust memory
        try:
            self.debugger.HandleCommand(f"settings set target.max-memory-read-size {self.MAX_MEMORY_READ_BYTES}")
        except Exception:
            pass
        self.target = None
        self.process = None
        self.is_attached = False

        # Install SIGINT handler to gracefully interrupt execution without terminating daemon
        def _handle_sigint(signum, frame):
            try:
                if self.process and self.process.IsValid() and self.process.GetState() == lldb.eStateRunning:
                    self.process.Stop()
                self.debugger.DispatchInputInterrupt()
            except Exception:
                pass

        try:
            signal.signal(signal.SIGINT, _handle_sigint)
        except Exception:
            pass

    def _process_state_report(self) -> str:
        """Safe human-readable process state description."""
        try:
            if not self.process or not self.process.IsValid():
                return "no process"
            state = lldb.SBDebugger.StateAsCString(self.process.GetState())
            report = f"process {self.process.GetProcessID()} state: {state}"
            if self.process.GetState() == lldb.eStateExited:
                report += f" (exit status: {self.process.GetExitStatus()})"
            return report
        except Exception:
            return "process state unavailable"

    def _get_live_info(self) -> tuple:
        """Helper to get current live target and pid."""
        try:
            if self.target and self.target.IsValid():
                self.process = self.target.GetProcess()
            live_pid = self.process.GetProcessID() if (self.process and self.process.IsValid()) else None
            live_target = None
            if self.target and self.target.IsValid():
                exe = self.target.GetExecutable()
                if exe and exe.IsValid():
                    live_target = exe.GetFilename()
            return live_pid, live_target
        except Exception:
            return None, None

    def execute_command(self, cmd_str: str, timeout_sec: float = 15.0) -> dict:
        """Executes one LLDB command with thread timeout containment and resource bounds."""
        if not self.debugger.IsValid():
            return {
                "command": cmd_str,
                "output": "Error: Debugger is not valid",
                "process_state": "unavailable",
                "output_truncated": False,
                "completion_status": "unknown",
            }

        cmd_str = cmd_str.strip()
        res = lldb.SBCommandReturnObject()
        result = {}

        # Set up in-flight bounded streaming via non-blocking pipe to drain output
        # without writing to disk or accumulating unbounded heap memory.
        pipe_cap = None
        sbfile_out = None
        sbfile_err = None
        if hasattr(lldb, "SBFile") and hasattr(res, "SetImmediateOutputFile"):
            try:
                pipe_cap = _BoundedPipeCapture(self.MAX_OUTPUT_CHARS)
                sbfile_out = lldb.SBFile(pipe_cap.w_fd, "w", False)
                sbfile_err = lldb.SBFile(pipe_cap.w_fd, "w", False)
                res.SetImmediateOutputFile(sbfile_out)
                res.SetImmediateErrorFile(sbfile_err)
            except Exception:
                if pipe_cap:
                    pipe_cap.close()
                    pipe_cap = None

        def _run():
            try:
                self.debugger.GetCommandInterpreter().HandleCommand(cmd_str, res)
                if hasattr(res, "flush"):
                    res.flush()
            finally:
                result["done"] = True

        def _read_bounded_output():
            out = ""
            is_truncated = False

            out_size = res.GetOutputSize() if hasattr(res, "GetOutputSize") else 0
            err_size = res.GetErrorSize() if hasattr(res, "GetErrorSize") else 0
            if out_size > self.MAX_OUTPUT_CHARS or err_size > self.MAX_OUTPUT_CHARS:
                is_truncated = True

            if pipe_cap:
                try:
                    pipe_out, pipe_trunc = pipe_cap.finish()
                    if pipe_trunc:
                        is_truncated = True
                    out = pipe_out
                except Exception:
                    pass

            # Fallback to direct return-object access if streaming pipe was unused or produced no output
            if not out:
                raw_out = res.GetOutput() or "" if hasattr(res, "GetOutput") else ""
                raw_err = res.GetError() or "" if hasattr(res, "GetError") else ""
                if len(raw_out) > self.MAX_OUTPUT_CHARS:
                    raw_out = raw_out[:self.MAX_OUTPUT_CHARS]
                    is_truncated = True
                if len(raw_err) > self.MAX_OUTPUT_CHARS:
                    raw_err = raw_err[:self.MAX_OUTPUT_CHARS]
                    is_truncated = True
                out = f"{raw_out}\n{raw_err}".strip() if (raw_err and raw_out) else (raw_out or raw_err).strip()

            if len(out) > self.MAX_OUTPUT_CHARS:
                out = out[:self.MAX_OUTPUT_CHARS]
                is_truncated = True

            return out.strip(), is_truncated

        try:
            t = threading.Thread(target=_run, daemon=True)
            t.start()
            t.join(timeout=timeout_sec)

            live_pid, live_target = self._get_live_info()

            if not t.is_alive():
                combined, truncated = _read_bounded_output()
                state_desc = self._process_state_report()
                return {
                    "command": cmd_str,
                    "output": combined,
                    "process_state": state_desc,
                    "output_truncated": truncated,
                    "completion_status": "complete" if not truncated else "partial",
                    "pid": live_pid,
                    "target": live_target,
                }

            # Timed out - interrupt execution safely so command thread does not run unbounded
            try:
                if self.process and self.process.IsValid() and self.process.GetState() == lldb.eStateRunning:
                    self.process.Stop()
                self.debugger.DispatchInputInterrupt()
            except Exception:
                pass
            t.join(timeout=0.5)

            live_pid, live_target = self._get_live_info()
            partial, truncated = _read_bounded_output()
            timeout_msg = f"[!] Command timed out after {timeout_sec}s; {self._process_state_report()}"
            combined_timeout = f"{partial}\n{timeout_msg}".strip() if partial else timeout_msg
            if len(combined_timeout) > self.MAX_OUTPUT_CHARS:
                combined_timeout = combined_timeout[:self.MAX_OUTPUT_CHARS]
                truncated = True

            return {
                "command": cmd_str,
                "output": combined_timeout,
                "process_state": self._process_state_report(),
                "output_truncated": truncated,
                "completion_status": "unknown",
                "pid": live_pid,
                "target": live_target,
            }
        finally:
            if pipe_cap:
                pipe_cap.close()

    def launch(
        self,
        target_path: str,
        args: list = None,
        env: dict = None,
        stop_at_entry: bool = True,
        disable_aslr: bool = True,
        cwd: str = None,
        stdin_file: str = None,
        stdout_file: str = None,
        breakpoints: list = None,
    ) -> dict:
        """Creates target, sets options, and launches inferior process."""
        if not self.debugger.IsValid():
            return {"error": "Debugger is not valid", "status": "failed"}

        target_path = os.path.abspath(target_path)
        if not os.path.exists(target_path):
            return {"error": f"Binary not found: {target_path}", "status": "failed"}

        # Configure ASLR
        init_res = lldb.SBCommandReturnObject()
        aslr_val = "true" if disable_aslr else "false"
        self.debugger.GetCommandInterpreter().HandleCommand(
            f"settings set target.disable-aslr {aslr_val}", init_res
        )

        error = lldb.SBError()
        self.target = self.debugger.CreateTarget(target_path, None, None, True, error)
        if not error.Success() or not self.target.IsValid():
            return {"error": f"Failed to create target: {error.GetCString()}", "status": "failed"}

        # Set initial breakpoints if provided
        bp_reports = []
        if breakpoints:
            for bp in breakpoints:
                if bp.startswith("0x") or bp.startswith("0X"):
                    try:
                        addr = int(bp, 16)
                        b = self.target.BreakpointCreateByAddress(addr)
                        bp_reports.append(f"Breakpoint at address {bp}: ID {b.GetID()}")
                    except ValueError:
                        pass
                else:
                    b = self.target.BreakpointCreateByName(bp)
                    bp_reports.append(f"Breakpoint at {bp}: ID {b.GetID()} ({b.GetNumLocations()} locations)")

        args_list = args or []
        env_list = [f"{k}={v}" for k, v in (env or {}).items()]
        working_dir = cwd or os.path.dirname(target_path)
        stdin_path = stdin_file or None
        out_path = stdout_file or None

        launch_res = {}

        def _do_launch():
            err_obj = lldb.SBError()
            proc = self.target.Launch(
                self.debugger.GetListener(),
                args_list,
                env_list,
                stdin_path,
                out_path,
                out_path,
                working_dir,
                0,
                stop_at_entry,
                err_obj,
            )
            launch_res["proc"] = proc
            launch_res["err"] = err_obj

        t = threading.Thread(target=_do_launch, daemon=True)
        t.start()
        t.join(timeout=10.0)

        if t.is_alive():
            return {
                "error": "Target launch timed out after 10s (possible sync-mode event stall).",
                "status": "timeout",
            }

        self.process = launch_res.get("proc")
        launch_err = launch_res.get("err")

        if not launch_err or not launch_err.Success() or not self.process or not self.process.IsValid():
            err_msg = launch_err.GetCString() if launch_err else "unknown launch error"
            return {"error": f"Launch failed: {err_msg}", "status": "failed"}

        self.is_attached = False
        pid = self.process.GetProcessID()
        state = lldb.SBDebugger.StateAsCString(self.process.GetState())

        return {
            "status": "launched",
            "pid": pid,
            "state": state,
            "target": target_path,
            "breakpoints": bp_reports,
        }

    def attach(self, pid: int = None, name: str = None) -> dict:
        """Attaches to an active process by PID or image name."""
        if not self.debugger.IsValid():
            return {"error": "Debugger is not valid", "status": "failed"}

        error = lldb.SBError()
        listener = self.debugger.GetListener()

        if pid is not None:
            self.target = self.debugger.CreateTarget("", None, None, True, error)
            self.process = self.target.AttachToProcessWithID(listener, int(pid), error)
        elif name:
            self.target = self.debugger.CreateTarget("", None, None, True, error)
            self.process = self.target.AttachToProcessWithName(listener, str(name), False, error)
        else:
            return {"error": "Either pid or name must be provided to attach", "status": "failed"}

        if not error.Success() or not self.process or not self.process.IsValid():
            return {"error": f"Attach failed: {error.GetCString()}", "status": "failed"}

        self.is_attached = True
        attached_pid = self.process.GetProcessID()
        state = lldb.SBDebugger.StateAsCString(self.process.GetState())

        return {
            "status": "attached",
            "pid": attached_pid,
            "state": state,
        }

    def status(self) -> dict:
        """Queries current process and debugger lifecycle state."""
        if not self.debugger.IsValid():
            return {"state": "closed", "process_state": "unavailable", "pid": None, "target": None}

        if self.target and self.target.IsValid():
            self.process = self.target.GetProcess()

        pid = None
        state_str = "no_process"
        if self.process and self.process.IsValid():
            pid = self.process.GetProcessID()
            state_str = lldb.SBDebugger.StateAsCString(self.process.GetState())

        target_path = None
        if self.target and self.target.IsValid():
            exe = self.target.GetExecutable()
            if exe and exe.IsValid():
                target_path = exe.GetFilename()

        return {
            "state": "ready",
            "process_state": state_str,
            "pid": pid,
            "target": target_path,
        }

    def close(self) -> dict:
        """Terminates or detaches the inferior and destroys LLDB objects."""
        target_state = "none_observed"
        try:
            if self.target and self.target.IsValid():
                self.process = self.target.GetProcess()
            if self.process and self.process.IsValid():
                state = self.process.GetState()
                if state not in (lldb.eStateExited, lldb.eStateDetached):
                    if self.is_attached:
                        err = self.process.Detach()
                        if err is not None and hasattr(err, "Fail") and err.Fail():
                            target_state = "unknown"
                        else:
                            target_state = "detached"
                    else:
                        err = self.process.Kill()
                        if err is not None and hasattr(err, "Fail") and err.Fail():
                            target_state = "unknown"
                        else:
                            target_state = "terminated"
                else:
                    target_state = "exited"
        except Exception:
            target_state = "unknown"

        if target_state != "unknown":
            try:
                if self.debugger.IsValid():
                    lldb.SBDebugger.Destroy(self.debugger)
            except Exception:
                pass

        return {
            "status": "closed" if target_state != "unknown" else "failed",
            "target_state": target_state,
        }

    def serve(self):
        """Processes line-delimited JSON-RPC requests over stdin."""
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
            except Exception as e:
                err_resp = {"jsonrpc": "2.0", "error": {"code": -32700, "message": f"Parse error: {e}"}}
                sys.stdout.write(json.dumps(err_resp) + "\n")
                sys.stdout.flush()
                continue

            req_id = msg.get("id")
            method = msg.get("method")
            params = msg.get("params", {})

            try:
                if method == "initialize":
                    res = {
                        "status": "ready",
                        "version": self.debugger.GetVersionString(),
                    }
                elif method == "launch":
                    res = self.launch(
                        target_path=params.get("path"),
                        args=params.get("args", []),
                        env=params.get("env", {}),
                        stop_at_entry=params.get("stop_at_entry", True),
                        disable_aslr=params.get("disable_aslr", True),
                        cwd=params.get("cwd"),
                        stdin_file=params.get("stdin_file"),
                        stdout_file=params.get("stdout_file"),
                        breakpoints=params.get("breakpoints", []),
                    )
                elif method == "attach":
                    res = self.attach(
                        pid=params.get("pid"),
                        name=params.get("name"),
                    )
                elif method == "command":
                    timeout_val = float(params.get("timeout", 15.0))
                    res = self.execute_command(
                        cmd_str=params.get("command", ""),
                        timeout_sec=timeout_val,
                    )
                elif method == "status":
                    res = self.status()
                elif method == "close":
                    res = self.close()
                    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": res}) + "\n")
                    sys.stdout.flush()
                    break
                else:
                    res = {"error": f"Unknown method: {method}"}

                sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": res}) + "\n")
                sys.stdout.flush()
            except Exception as e:
                err_resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32603,
                        "message": f"Internal error: {e}",
                        "trace": traceback.format_exc(),
                    },
                }
                sys.stdout.write(json.dumps(err_resp) + "\n")
                sys.stdout.flush()


if __name__ == "__main__":
    daemon = ReaLldbSessionDaemon()
    daemon.serve()
