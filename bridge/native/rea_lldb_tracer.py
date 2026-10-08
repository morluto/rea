"""Bounded native call observation executed inside LLDB's embedded Python.

REA imports this module into `lldb --batch` and runs `rea_trace <config.json>`.
It launches one owned process, stops at the requested functions and
Objective-C methods, records each entry from registers and memory reads only,
continues, and kills the process once it exits, the event limit is reached or
the duration elapses. No expression is evaluated and no target code runs on
the tracer's behalf. The result is written as JSON to the configured path.
"""

import json
import time

import lldb

ARGUMENT_REGISTERS = {
    "arm64": ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"],
    "arm64e": ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"],
    "x86_64": ["rdi", "rsi", "rdx", "rcx", "r8", "r9"],
    "x86_64h": ["rdi", "rsi", "rdx", "rcx", "r8", "r9"],
}
MAX_SELECTOR_BYTES = 1024
MAX_REPORTED_LOCATIONS = 64
MAX_OTHER_STOPS = 256
LISTENER_NAME = "rea-native-call-observation"


def _hex(value):
    return "0x%x" % value


def _location(address, target):
    """Load and file address, module and symbol of one code address."""
    module = address.GetModule()
    symbol = address.GetSymbol()
    file_address = address.GetFileAddress()
    return {
        "load_address": _hex(address.GetLoadAddress(target)),
        "file_address": None
        if file_address == lldb.LLDB_INVALID_ADDRESS
        else _hex(file_address),
        "module": module.GetFileSpec().GetFilename() if module.IsValid() else None,
        "module_path": str(module.GetFileSpec()) if module.IsValid() else None,
        "symbol": symbol.GetName() if symbol.IsValid() else None,
    }


def _no_files():
    return lldb.SBFileSpecList()


def _create_breakpoints(target, spec):
    """LLDB breakpoints for one request; a class-qualified method may need two."""
    if spec["kind"] == "function":
        modules = lldb.SBFileSpecList()
        if spec.get("module"):
            modules.Append(lldb.SBFileSpec(spec["module"], False))
        return [
            target.BreakpointCreateByName(
                spec["name"], lldb.eFunctionNameTypeAuto, modules, _no_files()
            )
        ]
    class_name = spec.get("class_name")
    method_type = spec.get("method_type", "any")
    if class_name is None:
        return [
            target.BreakpointCreateByName(
                spec["selector"], lldb.eFunctionNameTypeSelector, _no_files(), _no_files()
            )
        ]
    prefixes = {"instance": ["-"], "class": ["+"], "any": ["-", "+"]}[method_type]
    return [
        target.BreakpointCreateByName(
            "%s[%s %s]" % (prefix, class_name, spec["selector"]),
            lldb.eFunctionNameTypeFull,
            _no_files(),
            _no_files(),
        )
        for prefix in prefixes
    ]


def _dynamic_class(target, pointer):
    """Class of an Objective-C receiver from LLDB's runtime reader, without running code."""
    if pointer == 0:
        return None
    data = lldb.SBData.CreateDataFromUInt64Array(
        target.GetByteOrder(), target.GetAddressByteSize(), [pointer]
    )
    value = target.CreateValueFromData(
        "receiver", data, target.GetBasicType(lldb.eBasicTypeObjCID)
    )
    dynamic = value.GetDynamicValue(lldb.eDynamicDontRunTarget)
    name = dynamic.GetTypeName() if dynamic.IsValid() else None
    if not name or name in ("id", "objc_object *"):
        return None
    return name[:-2] if name.endswith(" *") else name


def _wanted(spec, symbol):
    """Selector-only requests may admit only instance or only class methods."""
    if spec["kind"] != "objc-method" or spec.get("class_name") is not None:
        return True
    method_type = spec.get("method_type", "any")
    if method_type == "any":
        return True
    return symbol.startswith("-[" if method_type == "instance" else "+[")


def _record(context, thread, index, sequence):
    target, process, config = context["target"], context["process"], context["config"]
    frame = thread.GetFrameAtIndex(0)
    location = _location(frame.GetPCAddress(), target)
    symbol = location["symbol"] or ""
    if not _wanted(config["breakpoints"][index], symbol):
        return None
    names = ARGUMENT_REGISTERS.get(config["architecture"], [])
    registers = [
        {"name": name, "value": _hex(frame.FindRegister(name).GetValueAsUnsigned())}
        for name in names[: config["argument_registers"]]
    ]
    receiver_class = None
    selector = None
    if symbol.startswith("-[") or symbol.startswith("+["):
        error = lldb.SBError()
        text = process.ReadCStringFromMemory(
            frame.FindRegister(names[1]).GetValueAsUnsigned(),
            MAX_SELECTOR_BYTES,
            error,
        )
        selector = text if error.Success() and text else None
        if symbol.startswith("-["):
            receiver_class = _dynamic_class(
                target, frame.FindRegister(names[0]).GetValueAsUnsigned()
            )
    frames = min(thread.GetNumFrames(), 1 + config["backtrace_frames"])
    record = {
        "sequence": sequence,
        "elapsed_ms": round((time.monotonic() - context["started"]) * 1000, 3),
        "thread_id": thread.GetThreadID(),
        "breakpoint_index": index,
        "receiver_class": receiver_class,
        "selector": selector,
        "registers": registers,
        "backtrace": [
            _location(thread.GetFrameAtIndex(depth).GetPCAddress(), target)
            for depth in range(1, frames)
        ],
    }
    record.update(location)
    return record


def _handle_stop(context, events, other_stops):
    """Record breakpoint hits of one stop; return an outcome when tracing must end."""
    process = context["process"]
    for thread in process:
        reason = thread.GetStopReason()
        if reason == lldb.eStopReasonBreakpoint:
            index = context["breakpoint_index"].get(thread.GetStopReasonDataAtIndex(0))
            if index is None:
                continue
            record = _record(context, thread, index, len(events))
            if record is not None:
                events.append(record)
            if len(events) >= context["config"]["max_events"]:
                return "event-limit"
        elif reason in (lldb.eStopReasonSignal, lldb.eStopReasonException):
            other_stops.append(thread.GetStopDescription(256))
            if len(other_stops) >= MAX_OTHER_STOPS:
                return "stop-limit"
    return None


def _breakpoint_report(target, created):
    report = []
    for index, breakpoints in enumerate(created):
        locations = []
        count = 0
        for breakpoint in breakpoints:
            count += breakpoint.GetNumLocations()
            for position in range(breakpoint.GetNumLocations()):
                if len(locations) < MAX_REPORTED_LOCATIONS:
                    locations.append(
                        _location(breakpoint.GetLocationAtIndex(position).GetAddress(), target)
                    )
        report.append({"index": index, "location_count": count, "locations": locations})
    return report


def _launch_info(target, config, listener):
    launch = lldb.SBLaunchInfo(config["arguments"])
    launch.SetListener(listener)
    environment = target.GetEnvironment()
    for key, value in config["environment"].items():
        environment.Set(key, value, True)
    launch.SetEnvironment(environment, False)
    if config.get("working_directory"):
        launch.SetWorkingDirectory(config["working_directory"])
    launch.AddOpenFileAction(0, "/dev/null", True, False)
    launch.AddOpenFileAction(1, config["stdout_path"], False, True)
    launch.AddOpenFileAction(2, config["stderr_path"], False, True)
    return launch


def _wait_for_exit(listener, process, seconds):
    event = lldb.SBEvent()
    deadline = time.monotonic() + seconds
    while process.GetState() != lldb.eStateExited and time.monotonic() < deadline:
        listener.WaitForEvent(1, event)


def trace(debugger, config):
    debugger.SetAsync(True)
    # Stop at the symbol itself, where argument registers still hold the ABI
    # arguments, even when line tables would let LLDB skip the prologue.
    lldb.SBDebugger.SetInternalVariable(
        "target.skip-prologue", "false", debugger.GetInstanceName()
    )
    error = lldb.SBError()
    target = debugger.CreateTarget(
        config["executable"], config["architecture"], None, False, error
    )
    if not target.IsValid():
        return {"status": "target-error", "error": error.GetCString()}
    created = [_create_breakpoints(target, spec) for spec in config["breakpoints"]]
    breakpoint_index = {}
    for index, breakpoints in enumerate(created):
        for breakpoint in breakpoints:
            breakpoint_index[breakpoint.GetID()] = index
    listener = lldb.SBListener(LISTENER_NAME)
    started = time.monotonic()
    process = target.Launch(_launch_info(target, config, listener), error)
    if not error.Success() or not process.IsValid():
        return {"status": "launch-error", "error": error.GetCString()}
    with open(config["pid_path"], "w") as handle:
        handle.write(str(process.GetProcessID()))
    context = {
        "target": target,
        "process": process,
        "config": config,
        "started": started,
        "breakpoint_index": breakpoint_index,
    }
    events = []
    other_stops = []
    outcome = None
    deadline = started + config["duration_ms"] / 1000
    event = lldb.SBEvent()
    while outcome is None:
        if time.monotonic() >= deadline:
            outcome = "duration-elapsed"
            break
        if not listener.WaitForEvent(1, event):
            continue
        if not lldb.SBProcess.EventIsProcessEvent(event):
            continue
        state = lldb.SBProcess.GetStateFromEvent(event)
        if state == lldb.eStateExited:
            outcome = "exited"
        elif state == lldb.eStateStopped and not lldb.SBProcess.GetRestartedFromEvent(event):
            outcome = _handle_stop(context, events, other_stops)
            if outcome is None:
                process.Continue()
    pid = process.GetProcessID()
    exit_status = None
    exit_description = None
    if outcome == "exited":
        exit_status = process.GetExitStatus()
        exit_description = process.GetExitDescription()
    else:
        process.Kill()
        _wait_for_exit(listener, process, 5)
    return {
        "status": "traced",
        "version": lldb.SBDebugger.GetVersionString().splitlines()[0],
        "pid": pid,
        "outcome": outcome,
        "exit_status": exit_status,
        "exit_description": exit_description,
        "killed": outcome != "exited",
        "terminated": process.GetState() == lldb.eStateExited,
        "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        "breakpoints": _breakpoint_report(target, created),
        "events": events,
        "other_stops": other_stops,
    }


def run(debugger, command, result, internal_dict):
    """LLDB command entry point: `rea_trace <config.json>`."""
    with open(command.strip()) as handle:
        config = json.load(handle)
    try:
        output = trace(debugger, config)
    except Exception as error:  # Reported as a tracer failure, never re-raised into LLDB.
        output = {"status": "tracer-error", "error": "%s: %s" % (type(error).__name__, error)}
    with open(config["result_path"], "w") as handle:
        json.dump(output, handle)


def __lldb_init_module(debugger, internal_dict):
    debugger.HandleCommand("command script add -f rea_lldb_tracer.run rea_trace")
