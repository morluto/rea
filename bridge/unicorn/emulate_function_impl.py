"""Run one x86_64 function in isolation under Unicorn and report observable effects.

Protocol: invoked as `emulate_function.py <failure-marker-path> <request-path>`.
The request JSON names the reply path. The bridge writes exactly one reply
JSON object to that path and exits 0, whether the run succeeded or stopped
early. Resource failures that prevent a reply are surfaced through the marker
file / exit status convention shared with the pwntools bridges (75 = memory,
76 = file size); anything else nonzero is a bridge crash.

Safety contract (Phase 1):
- Nothing is read from the host process or filesystem at run time besides the
  request file. The emulated function never executes a host syscall: syscall
  instructions are hooked, recorded, and stubbed; imported calls are stubbed
  through mapped stub pages that contain a single `ret`.
- No network, no subprocesses, no writes outside the reply path (and the
  marker path on resource failure).
- The function runs only against caller-declared memory. Code outside the
  declared function bytes stops the run with `escaped_code_region`.
"""
import json
import os
import signal
import sys

PINNED_UNICORN_VERSION = "2.1.2"
SENTINEL_RETURN_ADDRESS = 0x0BADF00D
PAGE_SIZE = 0x1000

MAX_INSTRUCTION_CAP = 100_000_000
MAX_TIMEOUT_MS = 120_000
MAX_ADDRESS_SPACE_BYTES = 3 * 1024 * 1024 * 1024
MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_MEMORY_DIFF_BYTES = 1024 * 1024

# General-purpose registers the caller may set. RIP and RSP are derived from
# the entry offset and the stack setup and are never caller-settable.
REGISTER_IDS = None  # filled after the unicorn import

STOP_REASONS = (
    "returned",
    "unmapped_access",
    "unsupported_instruction",
    "stubbed_call",
    "instruction_budget_exhausted",
    "timeout",
    "escaped_code_region",
)


class RequestError(Exception):
    """Caller input failed bridge-side validation (reported, not raised)."""


def _align_down(address):
    return address & ~(PAGE_SIZE - 1)


def _align_up(size):
    return (size + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1)


def _parse_hex(value, field):
    if not isinstance(value, str):
        raise RequestError("%s must be a hex string" % field)
    if len(value) % 2 != 0 or any(c not in "0123456789abcdefABCDEF" for c in value):
        raise RequestError("%s must be even-length hex" % field)
    return bytes.fromhex(value)


def _parse_address(value, field):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RequestError("%s must be a non-negative integer" % field)
    if value >= 1 << 64:
        raise RequestError("%s exceeds 64 bits" % field)
    return value


def _parse_stub_key(value):
    if not isinstance(value, str):
        raise RequestError("stub addresses must be hex strings")
    try:
        address = int(value, 0)
    except ValueError:
        raise RequestError("stub address %r is not parseable" % value)
    if address < 0 or address >= 1 << 64:
        raise RequestError("stub address %r is out of range" % value)
    return address


def _check_overlap(ranges, what):
    ordered = sorted(ranges)
    for (start_a, end_a), (start_b, end_b) in zip(ordered, ordered[1:]):
        if start_b < end_a:
            raise RequestError(
                "%s overlap: [%s, %s) and [%s, %s)" % (what, hex(start_a), hex(end_a), hex(start_b), hex(end_b))
            )


def validate_request(request):
    """Validate and normalize one emulation request. Raises RequestError."""
    if not isinstance(request, dict):
        raise RequestError("request must be a JSON object")
    if request.get("architecture") != "x86_64":
        raise RequestError("Phase 1 supports x86_64 only")
    function_bytes = _parse_hex(request.get("function_bytes", ""), "function_bytes")
    if not function_bytes:
        raise RequestError("function_bytes must not be empty")
    code_address = _parse_address(request.get("code_address"), "code_address")
    entry_offset = request.get("entry_offset", 0)
    if isinstance(entry_offset, bool) or not isinstance(entry_offset, int) or entry_offset < 0:
        raise RequestError("entry_offset must be a non-negative integer")
    if entry_offset >= len(function_bytes):
        raise RequestError("entry_offset is past the end of function_bytes")
    if code_address % PAGE_SIZE != 0:
        raise RequestError("code_address must be page-aligned")

    registers = request.get("registers", {})
    if not isinstance(registers, dict):
        raise RequestError("registers must be an object")
    normalized_registers = {}
    for name, value in registers.items():
        if name not in REGISTER_IDS:
            raise RequestError("unknown or derived register: %s" % name)
        normalized_registers[name] = _parse_address(value, "registers.%s" % name)

    memory = request.get("memory", [])
    if not isinstance(memory, list):
        raise RequestError("memory must be an array")
    normalized_memory = []
    total_input = len(function_bytes)
    for index, region in enumerate(memory):
        if not isinstance(region, dict):
            raise RequestError("memory[%d] must be an object" % index)
        address = _parse_address(region.get("address"), "memory[%d].address" % index)
        data = _parse_hex(region.get("bytes", ""), "memory[%d].bytes" % index)
        if address % PAGE_SIZE != 0:
            raise RequestError("memory[%d].address must be page-aligned" % index)
        normalized_memory.append((address, data))
        total_input += len(data)
    if total_input > MAX_INPUT_BYTES:
        raise RequestError("total input exceeds %d bytes" % MAX_INPUT_BYTES)

    stack_address = _parse_address(request.get("stack_address"), "stack_address")
    stack_size = request.get("stack_size", 65536)
    if isinstance(stack_size, bool) or not isinstance(stack_size, int) or stack_size <= 0:
        raise RequestError("stack_size must be a positive integer")
    if stack_address % PAGE_SIZE != 0:
        raise RequestError("stack_address must be page-aligned")

    stubs = request.get("stubs", {})
    if not isinstance(stubs, dict):
        raise RequestError("stubs must be an object")
    normalized_stubs = {}
    for key, value in stubs.items():
        normalized_stubs[_parse_stub_key(key)] = _parse_address(value, "stubs[%s]" % key)
    stub_policy = request.get("stub_policy", "record")
    if stub_policy not in ("record", "stop"):
        raise RequestError('stub_policy must be "record" or "stop"')

    budgets = request.get("budgets", {})
    if not isinstance(budgets, dict):
        raise RequestError("budgets must be an object")
    instruction_cap = budgets.get("instruction_cap", 1_000_000)
    timeout_ms = budgets.get("timeout_ms", 30_000)
    address_space_bytes = budgets.get("address_space_bytes", MAX_ADDRESS_SPACE_BYTES)
    for name, value, maximum in (
        ("instruction_cap", instruction_cap, MAX_INSTRUCTION_CAP),
        ("timeout_ms", timeout_ms, MAX_TIMEOUT_MS),
        ("address_space_bytes", address_space_bytes, MAX_ADDRESS_SPACE_BYTES),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > maximum:
            raise RequestError("budgets.%s must be in (0, %d]" % (name, maximum))

    code_range = (code_address, code_address + _align_up(len(function_bytes)))
    stack_range = (stack_address, stack_address + _align_up(stack_size))
    data_ranges = [
        (address, address + _align_up(len(data))) for address, data in normalized_memory
    ]
    _check_overlap([code_range, stack_range] + data_ranges, "memory region")
    stub_pages = {}
    for address in normalized_stubs:
        page = _align_down(address)
        stub_pages.setdefault(page, []).append(address)
    for page in stub_pages:
        for start, end in [code_range, stack_range] + data_ranges:
            if start <= page < end:
                raise RequestError("stub address %s falls inside a declared region" % hex(page))
    mapped_total = (code_range[1] - code_range[0]) + (stack_range[1] - stack_range[0])
    mapped_total += sum(end - start for start, end in data_ranges)
    mapped_total += len(stub_pages) * PAGE_SIZE
    if mapped_total > address_space_bytes:
        raise RequestError("mapped address space exceeds the budget")

    return {
        "function_bytes": function_bytes,
        "code_address": code_address,
        "entry_offset": entry_offset,
        "registers": normalized_registers,
        "memory": normalized_memory,
        "stack_address": stack_address,
        "stack_size": stack_size,
        "stubs": normalized_stubs,
        "stub_pages": stub_pages,
        "stub_policy": stub_policy,
        "instruction_cap": instruction_cap,
        "timeout_ms": timeout_ms,
    }


def _diff_runs(before, after):
    """Maximal contiguous changed runs as (offset, before_hex, after_hex)."""
    runs = []
    index = 0
    size = len(before)
    while index < size:
        if before[index] != after[index]:
            start = index
            while index < size and before[index] != after[index]:
                index += 1
            runs.append((start, before[start:index].hex(), after[start:index].hex()))
        else:
            index += 1
    return runs


def run_emulation(uc_module, x86, req):
    """Execute one validated request. Returns the ok:true reply body."""
    Uc = uc_module.Uc
    UC_ARCH_X86 = uc_module.UC_ARCH_X86
    UC_MODE_64 = uc_module.UC_MODE_64
    UC_PROT_ALL = uc_module.UC_PROT_ALL
    UC_HOOK_CODE = uc_module.UC_HOOK_CODE
    UC_HOOK_MEM_INVALID = uc_module.UC_HOOK_MEM_INVALID
    UC_HOOK_INSN = uc_module.UC_HOOK_INSN
    UC_MEM_FETCH_UNMAPPED = uc_module.UC_MEM_FETCH_UNMAPPED
    UC_X86_INS_SYSCALL = x86.UC_X86_INS_SYSCALL

    uc = Uc(UC_ARCH_X86, UC_MODE_64)
    code_address = req["code_address"]
    function_bytes = req["function_bytes"]
    code_end = code_address + len(function_bytes)
    stack_top = req["stack_address"] + req["stack_size"]
    stubs = req["stubs"]

    uc.mem_map(_align_down(code_address), _align_up(len(function_bytes)), UC_PROT_ALL)
    uc.mem_write(code_address, function_bytes)
    for address, data in req["memory"]:
        uc.mem_map(address, _align_up(len(data)), UC_PROT_ALL)
        if data:
            uc.mem_write(address, data)
    uc.mem_map(_align_down(req["stack_address"]), _align_up(req["stack_size"]), UC_PROT_ALL)
    uc.mem_write(stack_top - 8, SENTINEL_RETURN_ADDRESS.to_bytes(8, "little"))
    for page, addresses in req["stub_pages"].items():
        uc.mem_map(page, PAGE_SIZE, UC_PROT_ALL)
        for address in addresses:
            uc.mem_write(address, b"\xc3")  # ret: control returns to the caller

    # Snapshot post-setup memory so the diff reports function-caused writes only
    # (the sentinel slot itself is setup, not an effect).
    snapshot_regions = [(code_address, bytes(function_bytes))]
    snapshot_regions += [(address, bytes(data)) for address, data in req["memory"]]
    snapshot_regions.append((req["stack_address"], bytes(uc.mem_read(req["stack_address"], req["stack_size"]))))

    for name, value in req["registers"].items():
        uc.reg_write(REGISTER_IDS[name], value)
    uc.reg_write(x86.UC_X86_REG_RSP, stack_top - 8)
    uc.reg_write(x86.UC_X86_REG_RIP, code_address + req["entry_offset"])

    state = {
        "stop": None,
        "count": 0,
        "calls": [],
        "timed_out": False,
    }

    def read_register(name):
        return uc.reg_read(REGISTER_IDS[name])

    def read_stack_args():
        args = []
        rsp = uc.reg_read(x86.UC_X86_REG_RSP)
        for slot in range(2):
            try:
                args.append(int.from_bytes(uc.mem_read(rsp + 8 + slot * 8, 8), "little"))
            except Exception:
                break
        return args

    def hook_code(u, address, size, _data):
        state["count"] += 1
        if state["timed_out"]:
            state["stop"] = "timeout"
            u.emu_stop()
            return
        if state["count"] > req["instruction_cap"]:
            state["stop"] = "instruction_budget_exhausted"
            u.emu_stop()
            return
        if address in stubs:
            call = {
                "kind": "import",
                "address": address,
                "number": None,
                "arguments": {
                    "rdi": read_register("rdi"),
                    "rsi": read_register("rsi"),
                    "rdx": read_register("rdx"),
                    "rcx": read_register("rcx"),
                    "r8": read_register("r8"),
                    "r9": read_register("r9"),
                    "stack": read_stack_args(),
                },
                "stubbed": True,
                "returned": stubs[address],
            }
            state["calls"].append(call)
            if req["stub_policy"] == "stop":
                state["stop"] = "stubbed_call"
                u.emu_stop()
                return
            u.reg_write(x86.UC_X86_REG_RAX, stubs[address])
            return
        if not (code_address <= address < code_end):
            state["stop"] = "escaped_code_region"
            u.emu_stop()
            return

    def hook_mem_invalid(u, access, address, size, _value, _data):
        if access == UC_MEM_FETCH_UNMAPPED and address == SENTINEL_RETURN_ADDRESS:
            state["stop"] = "returned"
            return False
        state["stop"] = "unmapped_access"
        return False

    def hook_syscall(u, _data):
        state["calls"].append({
            "kind": "syscall",
            "address": None,
            "number": u.reg_read(x86.UC_X86_REG_RAX),
            "arguments": {
                "rdi": u.reg_read(x86.UC_X86_REG_RDI),
                "rsi": u.reg_read(x86.UC_X86_REG_RSI),
                "rdx": u.reg_read(x86.UC_X86_REG_RDX),
                "r10": u.reg_read(x86.UC_X86_REG_R10),
                "r8": u.reg_read(x86.UC_X86_REG_R8),
                "r9": u.reg_read(x86.UC_X86_REG_R9),
            },
            "stubbed": True,
            "returned": 0,
        })
        # Do not advance RIP: Unicorn advances past the syscall instruction
        # after an INSN hook returns. Only the stubbed return value is set.
        u.reg_write(x86.UC_X86_REG_RAX, 0)

    uc.hook_add(UC_HOOK_CODE, hook_code)
    uc.hook_add(UC_HOOK_MEM_INVALID, hook_mem_invalid)
    uc.hook_add(UC_HOOK_INSN, hook_syscall, None, 1, 0, UC_X86_INS_SYSCALL)

    def on_timeout(_signum, _frame):
        state["timed_out"] = True

    previous_handler = signal.signal(signal.SIGALRM, on_timeout)
    signal.setitimer(signal.ITIMER_REAL, req["timeout_ms"] / 1000.0)
    try:
        uc.emu_start(code_address + req["entry_offset"], code_end)
    except uc_module.UcError as error:
        if state["stop"] is None:
            if error.errno == uc_module.UC_ERR_INSN_INVALID:
                state["stop"] = "unsupported_instruction"
            elif error.errno in (
                uc_module.UC_ERR_FETCH_UNMAPPED,
                uc_module.UC_ERR_READ_UNMAPPED,
                uc_module.UC_ERR_WRITE_UNMAPPED,
            ):
                state["stop"] = "unmapped_access"
            else:
                raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
    if state["stop"] is None:
        # Clean stop with no recorded reason: execution reached the end of the
        # declared function bytes without returning.
        state["stop"] = "escaped_code_region"

    registers_out = {}
    for name in sorted(REGISTER_IDS):
        registers_out[name] = uc.reg_read(REGISTER_IDS[name])
    registers_out["rsp"] = uc.reg_read(x86.UC_X86_REG_RSP)
    registers_out["rip"] = uc.reg_read(x86.UC_X86_REG_RIP)

    memory_writes = []
    diff_bytes = 0
    truncated = False
    for address, before in snapshot_regions:
        try:
            after = bytes(uc.mem_read(address, len(before)))
        except Exception:
            continue
        for offset, before_hex, after_hex in _diff_runs(before, after):
            run_bytes = len(before_hex) // 2
            if diff_bytes + run_bytes > MAX_MEMORY_DIFF_BYTES:
                truncated = True
                break
            memory_writes.append({
                "address": address + offset,
                "before": before_hex,
                "after": after_hex,
            })
            diff_bytes += run_bytes
        if truncated:
            break

    return {
        "ok": True,
        "stop_reason": state["stop"],
        "return_value": registers_out["rax"] if state["stop"] == "returned" else None,
        "registers": registers_out,
        "memory_writes": memory_writes,
        "memory_diff_truncated": truncated,
        "calls_hit": state["calls"],
        "instructions_executed": state["count"],
        "engine": {"name": "unicorn", "version": PINNED_UNICORN_VERSION},
    }


def write_reply(path, reply):
    payload = json.dumps(reply).encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, payload)
    finally:
        os.close(descriptor)


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: emulate_function.py <failure-marker-path> <request-path>\n")
        return 2
    with open(sys.argv[2], "rb") as handle:
        request = json.loads(handle.read().decode("utf-8"))
    reply_path = request.get("reply_path")
    if not isinstance(reply_path, str) or not reply_path:
        sys.stderr.write("request.reply_path must be a non-empty string\n")
        return 2
    try:
        import unicorn
        import unicorn.x86_const as x86_const
    except ImportError as error:
        write_reply(reply_path, {
            "ok": False, "reason": "unavailable", "message": "unicorn import failed: %s" % error,
        })
        return 0
    global REGISTER_IDS
    REGISTER_IDS = {
        "rax": x86_const.UC_X86_REG_RAX,
        "rbx": x86_const.UC_X86_REG_RBX,
        "rcx": x86_const.UC_X86_REG_RCX,
        "rdx": x86_const.UC_X86_REG_RDX,
        "rsi": x86_const.UC_X86_REG_RSI,
        "rdi": x86_const.UC_X86_REG_RDI,
        "rbp": x86_const.UC_X86_REG_RBP,
        "r8": x86_const.UC_X86_REG_R8,
        "r9": x86_const.UC_X86_REG_R9,
        "r10": x86_const.UC_X86_REG_R10,
        "r11": x86_const.UC_X86_REG_R11,
        "r12": x86_const.UC_X86_REG_R12,
        "r13": x86_const.UC_X86_REG_R13,
        "r14": x86_const.UC_X86_REG_R14,
        "r15": x86_const.UC_X86_REG_R15,
    }
    if unicorn.__version__ != PINNED_UNICORN_VERSION:
        write_reply(reply_path, {
            "ok": False, "reason": "version_mismatch",
            "message": "unicorn version %s does not match the pinned %s"
            % (unicorn.__version__, PINNED_UNICORN_VERSION),
        })
        return 0
    if request.get("probe") is True:
        write_reply(reply_path, {
            "ok": True,
            "probe": {"engine": {"name": "unicorn", "version": PINNED_UNICORN_VERSION}},
        })
        return 0
    try:
        req = validate_request(request)
    except RequestError as error:
        write_reply(reply_path, {"ok": False, "reason": "format", "message": str(error)})
        return 0
    try:
        reply = run_emulation(unicorn, x86_const, req)
    except unicorn.UcError as error:
        write_reply(reply_path, {
            "ok": False, "reason": "decoder", "message": "unicorn error: %s" % error,
        })
        return 0
    write_reply(reply_path, reply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
