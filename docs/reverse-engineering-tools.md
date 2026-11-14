# Reverse-engineering tool integrations

REA can call caller-supplied GNU objdump, GDB, Rizin, and Radare2 installations. REA does not install or update these tools. Static objdump/Rizin/Radare2 workflows use the same services from CLI and MCP. GDB's persistent MCP sessions and ephemeral CLI command are available only on Linux. Persistent debugger sessions exist only for the lifetime of the REA MCP server process.

In a shared MCP server, unrestricted Rizin, Radare2, and Cutter commands, GDB console
commands, Rizin debugger start/close, and GDB debugger close retire any active
binary analysis session after the operation. This prevents a fresh analysis
provider from being rebound automatically while command effects may still be
writing. After the command and any background writers have stopped, call
`open_binary` explicitly before continuing analysis. A successful command
response alone does not prove that background writers have stopped. An active
Ghidra analysis session must be closed explicitly before an external mutation
can run.

## GNU objdump

REA sends GNU-style arguments to the selected command but does not verify its
implementation or version. Evidence identifies the command profile as
`objdump.command` and retains the selected executable; it does not claim that
the executable is GNU objdump. Other implementations may accept some commands
while differing in supported options and output.

`inspect_with_objdump` and `rea inspect-with-objdump` capture stdout and stderr as inline Evidence. Artifact inspection Evidence records SHA-256 digests before and after the provider call and whether those observed digests differ; this cannot prove the exact bytes consumed if the artifact changes during execution. Choose one artifact operation: `file_headers`, `section_headers`, `symbols`, `relocations`, `dwarf`, `disassemble`, or `disassemble_all`. `disassemble` maps to `-d`; `disassemble_all` maps to `-D` and has different symbol-boundary semantics. The pathless `inspect_with_objdump {"operation":"architectures"}` MCP call or `rea list-objdump-architectures` CLI command maps to `-i` and produces subjectless Evidence containing the selected command’s output, not a guarantee that any target is supported. GNU objdump uses this option to list its compiled-in BFD targets.

Failure to launch the selected executable reports provider unavailability, the
configured command and the host error under `boundary: "provider-launch"`.
Recovery concerns `REA_OBJDUMP_COMMAND`, PATH and execution permission, including
for target-free architecture listing. In MCP discovery (`binary_session`), an
unprobed executable is reported available; observing a launch failure marks the
operation unavailable with its remediation until a later dispatched request
succeeds. Artifact admission keeps separate input
and filesystem-read diagnostics. Invalid operation/selector combinations retain
their rejected fields in input issues before artifact reads or provider launch.

For DWARF, REA does not follow local debug links by default. Set `follow_debug_links` to `true` to pass `-WK`; external debug-file identities are not bound to Evidence when following links is enabled. The CLI flag is `--follow-debug-links`; `--no-follow-debug-links` or `--follow-debug-links=false` keeps the default. A separate `true` or `false` word after the flag is not its value. REA clears `DEBUGINFOD_URLS` in the objdump child environment to disable debuginfod network access on GNU binutils versions that do not support `-WE`. The complete raw output is authoritative; REA does not normalize it into a version-independent disassembly schema.

For a known native symbol, use `operation: "disassemble", symbol: "my_function"` in MCP or `--symbol my_function` in CLI. REA passes `--disassemble=my_function` to objdump before collecting output, rather than producing the whole disassembly and filtering it afterward. Omit `symbol` to keep full code-section disassembly. Other operations reject this selector. Use a nonempty, NUL-free name with well-formed Unicode; unsupported values are rejected before reading the artifact or starting objdump. Symbol names are passed unchanged; matching, versioned symbols, aliases and the end of the disassembly follow the selected executable's semantics. Evidence records the selector and actual arguments. An empty match does not establish artifact-wide absence, and the selected observation does not contain the omitted disassembly; request the complete operation when needed.

```sh
rea inspect-with-objdump ./program disassemble
rea inspect-with-objdump ./program disassemble --symbol my_function
rea inspect-with-objdump ./program dwarf
rea inspect-with-objdump ./program dwarf --follow-debug-links
```

Captured stdout and stderr share `max_output_bytes` (CLI: `--max-output-bytes`), default 16777216 bytes (16 MiB). Select an integer from 1 to 44651859 bytes. The maximum leaves room for worst-case JSON escaping of both Evidence output mirrors under Node's single-string ceiling. The selected budget applies on the next call without a restart; `output_budget_bytes` reports it and `output_budget_source` distinguishes a default from an explicit request. On exhaustion REA retains a prefix, requests provider termination, and marks `output_truncated` with unknown completion. Narrow or page the native command, or raise the selected budget. Verify command effects and outstanding cleanup before deciding whether repeating it is safe. Client deadlines and receive buffers remain separate. Concurrent one-shot captures reserve their selected budgets within a 128 MiB aggregate admission and eight-operation capacity; wait for active work or select a smaller output budget when that capacity is occupied.

`inspect_with_objdump`, `rea list-objdump-architectures`, one-shot `execute_rizin_command`, `execute_radare2_command`, and `compare_with_radiff2` accept `command_timeout_ms` (CLI: `--command-timeout-ms`). Omitted means 120000. The integer range is 1 to 2147483647. Target preflight shares one budget across stat and digest. The one-shot command receives that budget again. It applies on the next call; no restart is required. It does not raise the separately selected `max_output_bytes`, a Ghidra or Hopper startup deadline, or a debugger session deadline.

## GDB

Persistent GDB sessions, including the MCP workflow and one-shot `rea debug-with-gdb` CLI, are available only on Linux. REA verifies a live inferior's output descriptors through `/proc` before detaching it; it does not claim equivalent descriptor verification on macOS. Windows is also unsupported because owned Job Object cleanup can terminate debugger inferiors. On supported Linux hosts, `start_gdb_session`, `gdb_console`, `gdb_session_status`, and `close_gdb_session` manage a persistent GDB/MI session in MCP. The one-shot CLI requires a caller-selected durable TTY: `rea debug-with-gdb --inferior-tty /dev/pts/7 'file ./program'`. The TTY must remain available after GDB exits so a detached inferior can continue writing. MCP starts GDB with `--nx --quiet --interpreter=mi3`, retries initialization with MI2 if MI3 initialization returns an error and cleanup succeeds, waits for its prompt, and disables auto-loading. Pass optional `inferior_tty` to select the terminal that future inferior runs use; REA configures it before the session becomes ready and checks the exact value with GDB/MI. `gdb_session_status` reports the selected path, whether REA still considers the configuration verified, and whether invalid UTF-8 has been observed in MI bytes (`mi_invalid_utf8`) or stderr (`stderr_invalid_utf8`). Commands that can change the inferior TTY or redirect a run revoke that verification permanently for the session, so close retains GDB ownership if a live inferior remains. The complete built-in inspections `show inferior-tty` and `help inferior-tty` preserve verification; compound commands still use the conservative mutation checks. Closing a session with one live inferior and a verified TTY automatically detaches the target, which can resume execution; MCP clients receive destructive-operation annotations for this behavior. The console remains unrestricted and can run shell commands, change target state, access files, and use network in the REA process user's security context. Raw MI records and console/target/log streams are returned with Evidence; command output is retained up to the configured budget (16 MiB by default) and explicitly marked when truncated. A single console, target or log record over the 16 MiB MI line limit is dropped and the command is marked truncated, while an oversized result or async record still stops the session. GDB startup waits 10000 ms with no runtime override. Each MI command defaults to 120000 ms; its deadline, command-output budget, session capacity and pending-command queue use the [shared debugger launch settings](#debugger-launch-settings). `command_timeout_ms` does not change a persistent debugger session.

A truncated GDB command capture includes `output_limits` with the exact causes
and effective maxima: `command_bytes`, `command_records`, or `mi_line_bytes`.
Only byte-budget exhaustion recommends raising
`REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES`. The 16384-record retention ceiling and
16 MiB single-line protocol ceiling stay fixed; select a command with fewer or
smaller records when either is reached. These cause facts survive timeout,
cancellation and process-exit captures as well as successful commands.

With multiple live inferiors, or a live inferior without a verified TTY, manual
close requests an explicit disposition and keeps the session ready. Use
`gdb_console` to select and explicitly detach or terminate each remaining
inferior, then retry `close_gdb_session`. After owned cleanup has started,
console commands remain unavailable while that cleanup can be retried.

`completion_status` describes completion of the selected console command, not
termination of its inferior. After a `^running` result, REA queues a read-only
`-gdb-show mi-async` query and waits for its tokenized reply before releasing the
command's output collector. The ordered `records` include that query reply;
`mi` retains the console command's result. If raw shell stdout joins that
result without a newline, REA preserves the combined bytes as one raw record
and uses a fresh read-only query after GDB's prompt to establish completion.
It does not guess a result token inside caller output: `mi` is empty and the
original result class remains unknown. An inferior `*stopped` event or an
early compatibility prompt does not establish that an outer command file has
finished. See GDB's [MI output syntax](https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Output-Syntax.html)
and [command-file semantics](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Command-Files.html).

Before a normal close, REA checks for live GDB thread groups. If one remains and a durable `inferior_tty` is verified, REA asks GDB to detach it and confirms the detach before stopping the debugger. Without that sink, select and apply a disposition to each inferior through `gdb_console` (for example, detach or kill as appropriate), then retry close. REA never infers target ownership from a PID or path. When the MCP server shuts down, REA terminates only its directly owned GDB process after confirming no inferior or a sink-backed detach; otherwise it retains the process and its output streams for retry.

```text
start_gdb_session {"inferior_tty":"/dev/pts/7"}
gdb_console {"session_id":"…","command":"file ./program"}
gdb_console {"session_id":"…","command":"info files"}
gdb_session_status {"session_id":"…"}
close_gdb_session {"session_id":"…"}
```

## Rizin

`start_rizin_debug_session` and `rea debug-with-rizin` require an explicit `inferior_tty` on Linux. REA asks Rizin to launch the target with stdin, stdout and stderr routed to that caller-selected TTY and `dbg.exitkills=false`; the target can therefore continue running, reading input from the TTY and writing to it after REA closes the debugger. This is a visible target input and output effect, and the caller is responsible for selecting a suitable terminal that remains available. REA sends Rizin its commands on Rizin's own stdin, so a target left on that stream would read them. Before closing, REA serializes after the active command, parses the structured `olj` descriptor list, detaches only a unique `ptrace://` descriptor, confirms its absence, reads back `dbg.exitkills=false`, verifies `/proc/<pid>/fd/1` and `/proc/<pid>/fd/2` still identify the selected TTY by device and inode, and refuses to detach while `/proc/<pid>/fd/0` is Rizin's command stream. A target may close or replace its own stdin. If a previously identified inferior exits after Rizin confirms detach, REA verifies that the original process has ended instead of requiring output descriptors from an exited process. Unresolved identity or ambiguous readback keeps the Rizin session owned for retry. After output limits or a failed command interval, cleanup first waits up to 1000 ms for a fresh private NUL-delimited marker, discarding earlier frames before obtaining that new inferior readback. Synchronization never reopens user command admission. A missing marker, unavailable transport, or unknown inferior identity retains the cleanup owner. Caller cancellation keeps its exact reason and typed cancellation outcome even when cleanup remains incomplete; a successful retry resolves that retained cleanup state. Cancellation during final cleanup retains the captured observation and cleanup owner. An already observed startup or protocol failure remains primary and retains a later cancellation as a secondary failure; recovering the transport does not erase that original diagnosis. Persistent Rizin debugger sessions are unavailable outside Linux because this verification depends on `/proc`.

Persistent command Evidence retains the caller-selected and resolved startup paths in `parameters.launch_provenance`. These paths describe launch provenance, not the current target after unrestricted commands. `rizin_debug_session_status.output_invalid_utf8` reports whether lossy frame decoding has been observed during the session. Command Evidence sets `output_invalid_utf8` only when loss was observed in frames collected for that command, including retained partial output; earlier startup or command frames do not mark later valid output as lossy.

Session status retains up to 64 recent protocol frames. Each history entry keeps a complete-character UTF-8 prefix of at most 16 KiB, plus a truncation marker when needed; `recent_output_truncated` reports omitted history. This history budget also accounts for replacement characters from invalid UTF-8. It does not shorten command Evidence, whose output budget defaults to 16 MiB. Rizin debug startup waits 30000 ms with no runtime override. Each command frame defaults to 120000 ms; its deadline, command-output budget, session capacity and pending-command queue use the [shared debugger launch settings](#debugger-launch-settings). The 16777216-byte frame cap and 4096-frame command cap remain fixed. Evidence names the cap that stopped the command. The one-shot `command_timeout_ms` setting does not change a debug session.

### Stopped debugger sessions

A Rizin or GDB session stops accepting commands when REA stops it, for example after an output or frame limit, a command deadline, cancellation or a protocol failure, or when the debugger process exits. REA keeps the stopped session and the first reason it observed until `close_rizin_debug_session` or `close_gdb_session` releases it, including after a retried cleanup succeeds. `rizin_debug_session_status` and `gdb_session_status` then report `state: "closed"` with that reason in `closed_reason`. A later `rizin_debug_command` or `gdb_console` on the session fails with `capability_unavailable`; `details.reason` carries the same reason, and the remediation is to close the session and start a new one. A `session_id` that this server never returned, or that close already released, fails with `invalid_request` instead.

### Debugger launch settings

GDB and Rizin share these settings in the environment that launches REA:

| Setting                                 | Default        | Accepted decimal integer |
| --------------------------------------- | -------------- | ------------------------ |
| `REA_DEBUGGER_COMMAND_DEADLINE_MS`      | 120000 ms      | 1 to 2147483647 ms       |
| `REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES` | 16777216 bytes | 1 to 89303718 bytes      |
| `REA_DEBUGGER_MAX_SESSIONS`             | 8              | 1 to 64                  |
| `REA_DEBUGGER_MAX_PENDING_COMMANDS`     | 16             | 1 to 256                 |

Unset settings keep the defaults. Invalid values are refused when the setting
is used instead of falling back. Change the command deadline and output budget
for subsequent operations with `update_analysis_settings` using
`debugger.command_deadline_ms` and `debugger.max_command_output_bytes`. Session
and pending-command capacities require a restart. To change the launch values,
update REA's environment and restart; for MCP, edit the client registration and
restart that server.

These settings also apply to one-shot `rea debug-with-gdb` and
`rea debug-with-rizin` commands. They do not change the fixed initial-prompt
or owned-cleanup waits, Rizin's fixed frame and frame-count limits, or the
limits of `inspect_with_objdump` and `execute_rizin_command`. GDB
initialization and normal-close detach MI requests use the configured command
deadline, so a shorter selection can also time out those control commands.
Startup/detach control replies have a separate 16 MiB allowance that a smaller command-output setting
does not lower. A larger command deadline does not establish that a blocked
debugger can detach or that cleanup will succeed; retain and inspect any
`cleanup_incomplete` result before retrying.

```sh
rea debug-with-rizin --inferior-tty /dev/pts/7 ./program dr
```

`execute_rizin_command` and `rea execute-rizin-command` run one selected command against a local artifact. The one-shot profile uses `-N -q -e scr.color=0 -c`, suppressing user settings and scripts while leaving plugins available. Native terminal presentation defaults to plain text; the caller can explicitly enable colour with `e scr.color=1` in the selected command. REA preserves raw output, including literal ANSI bytes, and does not claim that command-specific JSON has one universal schema. Commands and plugins run with the REA process user's security context and may access files, the network, or perform other actions.

```sh
rea execute-rizin-command ./program iI
```

Rizin exits with status 0 even when its shell refuses a statement, so the exit code does not show whether the command ran. Rizin 0.6 through 0.9.1 log one of four stderr lines for such a refusal: `ERROR: Command '…' does not exist.`, ``ERROR: Wrong number of arguments passed to `…`…``, `ERROR: core: Error while executing command: …` (an invalid statement), or `ERROR: core: Error while parsing command: …`. Rizin then skips the refused statement and every later one in the command. When the completed process's stderr contains one of these lines, REA reports `completion_status: "rejected"` and adds a limitation naming the refusal. stdout then holds only the output of earlier statements, so empty stdout is not an empty result. Other `ERROR:` lines, such as `ERROR: Cannot find function at …`, come from commands that ran; REA keeps them in stderr and reports `complete`. A command that lowers `log.level` or redirects stderr hides refusals from REA.

Captured stdout and stderr use the same `max_output_bytes` (CLI: `--max-output-bytes`) admission and recovery described above, default 16 MiB. One-shot commands independently use `command_timeout_ms`. Raising output admission cannot recover an earlier capture; command effects and cleanup must be checked before another invocation.

### Decoder and map inputs

Four optional inputs select how Rizin decodes the artifact and where it maps
it. REA passes each one to Rizin before the artifact path:

| Input          | CLI option       | Rizin argument | Example              |
| -------------- | ---------------- | -------------- | -------------------- |
| `asm_arch`     | `--asm-arch`     | `-a`           | `arm`, `x86`, `6502` |
| `asm_bits`     | `--asm-bits`     | `-b`           | `16` for Thumb       |
| `asm_cpu`      | `--asm-cpu`      | `-e asm.cpu=`  | `cortexm`            |
| `base_address` | `--base-address` | `-n -m`        | `0x08000000`         |

Rizin 0.9.1 refuses `-e asm.arch=` and `-e asm.bits=` at startup, and Rizin
0.7.4 accepts them, so REA uses `-a` and `-b`, which both accept. Rizin applies
`-e` settings after `-a` and `-b`, so `asm_cpu` applies to the selected arch.

`base_address` is the address of file offset 0, as in REA's raw-binary inputs.
REA passes it as `-m` together with `-n`, so Rizin maps the whole file there as
a raw image and loads no format information, such as sections, symbols or an
entry point, even from an ELF file. Without `-n`, a Rizin format loader can
claim a raw image and give wrong reads with no error. In Rizin 0.9.1 the AVR
loader turns `io.va` off, so every read at the mapped address returns `0xff`.
In Rizin 0.7.4 and 0.9.1 the BIOS loader maps the file at another address.
A loader can also claim a raw image that you open with only `asm_*` inputs, so
pass `base_address`, `0x0` if the image has no known address. Evidence records
each input and the complete argument list.

With `-n`, Rizin has no headers to read, so arch, bits and byte order stay at
its defaults unless the call selects them. A Thumb image opened with only
`base_address` decodes as plausible AArch64 on an arm64 host. Pass `asm_arch`
and `asm_bits` with `base_address`, and for a big-endian image start the command
with `e cfg.bigendian=true`.

REA checks only the spelling. Arch and CPU names contain letters, digits, `_`,
`.`, `+` and `-`, and start with a letter or a digit. `asm_bits` is an integer
from 1 to 64. `base_address` is `0x` followed by 1 to 16 hexadecimal digits.
Rizin owns the names, and its builds differ: for example, the Homebrew build of
Rizin 0.9.1 has no `xtensa` or `riscv` plugin, while the official static Linux
build of Rizin 0.7.4 has both. The commands `e asm.arch=?` and `e asm.cpu=?`
list what the installed Rizin supports. To use another build, set
`REA_RIZIN_COMMAND`. When Rizin cannot apply an arch or bits value, it uses
another value and exits with status 0. Rizin 0.9.1 keeps its default and
reports the value on stderr. Rizin 0.7.4 reports an unknown arch on stderr, but
for `arm` it used 16 bits instead of 8 without a message. Both accept any
`asm.cpu` value, and `e asm.cpu` then echoes it, so compare it with
`e asm.cpu=?`, which lists the CPUs of the selected arch. Evidence therefore
states that REA does not confirm the decoder that Rizin used. To check the
decoder and the map, start the command with
`e asm.arch; e asm.bits; e asm.cpu; e cfg.bigendian; oml`.

This call reads a Cortex-M flash dump at its address, in Thumb state:

```sh
rea execute-rizin-command ./flash.bin "e asm.arch; e asm.bits; oml; pxw 8 @ 0x08000000" --asm-arch arm --asm-bits 16 --asm-cpu cortexm --base-address 0x08000000
```

Through MCP, the same call is:

```json
{
  "path": "/firmware/flash.bin",
  "command": "e asm.arch; e asm.bits; oml; pxw 8 @ 0x08000000",
  "asm_arch": "arm",
  "asm_bits": 16,
  "asm_cpu": "cortexm",
  "base_address": "0x08000000"
}
```

`pxw 8` prints the initial stack pointer and the Reset vector. The Reset vector
is a Thumb address with its low bit set. Disassemble the handler at the even
address, for example `pd 16 @ 0x08000108` for a Reset vector of `0x08000109`.

### Multi-segment ESP images

An app or bootloader image of the ESP32 family (the ESP32, ESP32-S, ESP32-C,
ESP32-H and ESP32-P series) starts with the magic byte `0xE9` and holds several
segments. ESP8266 images use a different header, and this recipe does not
cover them. Each segment loads at its own address, so one `base_address` cannot
map the image. Instead, remove the default map and add one `om` map for each
segment, in the same command:

1. Find the load address and the length of each segment, and the file offset
   of its data. The image header is 24 bytes. Each segment starts with an
   8-byte header that holds the load address and the data length, both 32-bit
   little-endian, and its data follows. So the data of the first segment
   starts at file offset `0x20`, and each later segment header follows the
   data of the segment before it. `esptool image-info` lists the same
   segments; esptool v4 spells it `image_info --version 2`. Its `File offs`
   column is the offset of the 8-byte segment header, so the data starts 8
   bytes later. A padding segment carries no code or data, and you can skip
   it.
2. Start the command with `e io.va=true`. Reads use the maps only while
   `io.va` is on, and a Rizin format loader can turn it off.
3. Rizin opens the image as file descriptor 3, which `ol` shows. For each
   segment, add this map, with `r-x` for code and `r--` for data:
   `om 3 <load address> <length> <data offset> <permissions> <name>`. A map
   cannot have more permissions than the opened file, which is read-only.
4. Select the decoder with `asm_arch` and set `asm_bits` to 32. ESP32, ESP32-S2
   and ESP32-S3 use Xtensa. The ESP32-C and ESP32-H series and ESP32-P4 use
   RISC-V. Use the plugin name that `e asm.arch=?` lists for the installed
   Rizin.

For example, for an image with an IRAM segment of 8 bytes at `0x40080000` and
a DRAM segment of 16 bytes at `0x3ffb0000`:

```sh
rea execute-rizin-command ./app.bin "e io.va=true; om-*; om 3 0x40080000 0x8 0x20 r-x iram0; om 3 0x3ffb0000 0x10 0x30 r-- dram0; oml; pd 4 @ 0x40080000" --asm-arch xtensa --asm-bits 32
```

`om-*` removes the maps that Rizin made when it opened the file, such as the
default map of the whole file at address 0. The entry address is the 32-bit
little-endian value at file offset 4.

## Radare2

`execute_radare2_command` and `rea execute-radare2-command` run one selected Radare2 command against a local artifact. The one-shot profile uses `-N -q -c`, suppressing user rcfiles while leaving plugins available. Commands and plugins run with the REA process user's security context and may access files, the network, or perform other actions. REA preserves raw output and does not claim that command-specific JSON has one universal schema; JSON-producing commands (the `j` suffix) return whatever the installed Radare2 emits.

Radare2 is a separate engine from Rizin; the two have diverged since the 2020 fork, and command names or JSON fields are not interchangeable between them. Point `REA_R2_COMMAND` at the radare2 executable you supply (for example via Homebrew, a distribution package, or a source build); REA never installs it or manages its `r2pm` packages.

```sh
rea execute-radare2-command ./program ij
```

Captured stdout and stderr are retained up to a 16 MiB combined limit; `output_truncated` marks output beyond that limit. One-shot commands use the `command_timeout_ms` budget described above.

Persistent analysis sessions are available through `start_radare2_session`, `radare2_command`, `radare2_session_status`, and `close_radare2_session`. A session runs `radare2 -N -q0` with NUL-delimited frames on every platform; no inferior, TTY, or `/proc` verification is involved because no target is executed. REA never runs analysis automatically — coverage is whatever commands the caller runs, so `aaa` (or a narrower variant) is the caller's first command. Commands inside a session are unrestricted like the one-shot tool and may access files, the shell, network, or loaded plugins; their effects are not bound to Evidence. Command output is returned raw, with `parsed` carrying a best-effort JSON projection when the output parses and the raw output remaining authoritative otherwise. Sessions are bounded: at most 8 concurrent sessions, 16 MiB per frame and per command, with per-command timeouts; exceeding a limit stops the session and returns retained partial output. Starting, running, or closing a session in a shared MCP server retires any active binary-analysis session, matching the one-shot tool. The session lives for the lifetime of the REA MCP server process.

```text
start_radare2_session {"path":"/tmp/program"}
radare2_command {"session_id":"…","command":"aaa"}
radare2_command {"session_id":"…","command":"aflj"}
radare2_session_status {"session_id":"…"}
close_radare2_session {"session_id":"…"}
```

Session commands speak the r2pipe2 protocol (radare2 5.9+): each command returns one JSON reply whose `res` field becomes `output`, and `command_error`, `command_code`, and `command_logs` carry the reply's error flag, return code, and log messages. radare2 reports many command failures — for example a missing decompiler plugin or decompiling at an offset with no function — with `error:false` and the reason in `logs`, so `command_logs` is preserved rather than trusting the flag alone. A frame that is not a r2pipe2 reply envelope is treated as a protocol failure and stops the session; a reply that failed before producing output (`error: true` with `logs` and no `res`) is a command failure, not a protocol failure, and keeps the session. Do not request `json:true` in the wrapper: on radare2 6.2.4 non-JSON command output produces invalid reply frames (a bare token or a missing `res` value), so REA keeps `res` as a string and applies its own lenient JSON projection. For `aflj` and `izzj`, a token-saving `summary` projection (reduced fields) accompanies the complete `parsed` value. Both listings still carry the raw output and the complete parse: on a 9.1 MiB `libc++_shared.so`, `aflj` produced 2.25 MB and `izzj` 7.17 MB of JSON, which exceeds the default 10 MiB MCP response budget; raise `REA_MCP_MAX_RESPONSE_BYTES` or use the CLI for targets that size. `start_radare2_session` accepts optional `initial_commands` (at most 16) that run once inside the start admission; a failing initial command closes the session and fails the start.

Decompilation is available through either surface when the r2ghidra plugin is installed by the user (`r2pm -ci r2ghidra`; REA never installs or manages plugins): run `pdg @ <function>` after analysis. Without the plugin, the failure surfaces in `command_logs`. The r2dec decompiler (`pdd @ <function>`, `r2pm -ci r2dec`) works the same way when installed. Both the one-shot and session profiles set `scr.color=0` so output carries no ANSI escapes.

`compare_with_radiff2` and `rea compare-with-radiff2` diff two local artifacts with the radare2-suite `radiff2` tool (`REA_RADIFF2_COMMAND`, default `radiff2`): `functions` maps to `-Cj -A` for a function-level JSON diff (addr/name/size/match rows), `bytes` maps to `-A` for the byte-level text diff. The comparison is read-only with a fixed operation set; Evidence digests cover `path_a` only and `path_b` remains caller-selected without a digest binding. One-shot commands use the `command_timeout_ms` budget described above.

ESIL emulation is available through session commands; REA adds no dedicated tool. A typical workflow on an analyzed binary: `aei` (init VM), `aeim` (init stack), `aeip` (seek to the program counter), `aer PC=<addr>` (set registers; `aer` lists them), then `aes`/`aesu <addr>` to step or step-until, and `ar <reg>` to read state. ESIL is an imprecise interpreter: it cannot emulate syscalls, imports, or SIMD instructions, so scope it to small self-contained chunks such as decryption or unpacking routines.

radare2 leaves relocations unapplied by default (`HINT: Relocs not applied`). REA keeps that engine default, because applying them never changed function or string discovery in measurements and buys cross references at an `aaa` time cost: on macOS Mach-O (`/bin/ls`, `/usr/bin/ssh`) the gain was 0.1-0.3% references for ~2% time, while on a relocation-heavy aarch64 Linux ELF (`libc++_shared.so`, 9.1 MiB) it was +2% references (95,192 → 97,124) for +5% time. When you want the fuller reference set, opt in per command by prefixing `e bin.relocs.apply=true` (for example `e bin.relocs.apply=true; aaa; axtj @ sym.func.main`); large ELF targets benefit the most.

## Cutter bridge

Cutter commands use the local REA Python bridge and authenticated loopback messages.
Discovery reads the session descriptors that the plugin publishes in the bridge
directory. Set `REA_CUTTER_BRIDGE_DIR` in both REA's environment and the environment
that starts Cutter to select a custom directory. Both expand `~` and `~/` paths
against the current user's home, including `~\` paths on Windows. By default,
they use `%LOCALAPPDATA%\REA\CutterBridge` on Windows when `LOCALAPPDATA` is set,
and `~/.cache/rea/cutter-bridge` otherwise. The two processes must resolve the
same directory for discovery to find the published sessions.

The client and plugin must support the current v2 handshake; older peers are
rejected before dispatch because they cannot preserve cross-caller recovery proof.
The client checks the final encoded request against
`REA_BRIDGE_MAX_REQUEST_BYTES` before dispatch. The budget applies to request
payload bytes and excludes the terminating LF. Unset, the ceiling is 16777216
bytes (16 MiB). A decimal integer from 7464 to 536870887 is accepted. The floor
fits the largest bounded symbol-name command inside an authenticated Cutter
frame. A Cutter status keeps its session id, connection proof, and up to 64
completion receipts when the frame is tight. The observed `current_file` is
included when it fits. When it does not, the status reports that path as
unknown, and the client does not reuse the descriptor path with the new
generation. The maximum is one byte under Node's 536870888-character string ceiling
so the framing LF still fits. The ceiling counts the encoded payload. A JSON
escape is measured before serialization and is not divided into the maximum
again. A structured Cutter reply is admitted when that encoded payload fits,
including a dense array of numbers. Cutter hashes the HMAC prefix and the payload as separate updates, so
an exact-limit frame does not build one preimage string. The plugin measures and signs the response
from bounded JSON pieces, then writes the authenticated frame in 64 KiB chunks. The bridge searches only the newly read bytes for the framing LF. The client unescapes each socket chunk into one response string, checks the proof, and then parses that string. A fitting reply keeps
the original output and does not retain the paged wire frame plus another concatenated copy. Zero, negative, non-decimal, and out-of-range
values are `configuration_invalid` and do not fall back to the default. The
bridge accepts that full payload size and rejects a larger payload while
bounding the read. An incomplete frame is still `Incomplete bridge request
frame`. An oversized command does not retain a cleanup owner. Hopper uses the
same request payload budget. A Hopper request is serialized when it reaches
the bridge, so one waiting behind Hopper's serial bridge does not retain
another copy of the encoded frame. REA injects a caller-selected value into the
Hopper bootstrap and the bridge also reads the process environment; an injected
value wins. Cutter reads the environment that starts Cutter and publishes
`max_request_bytes` on its session descriptor. A Hopper or Cutter process
started out of band without the setting uses 16777216 bytes. The client
compares that advertisement with its own ceiling before a discovery status probe and before sending a command. A different ceiling is a mismatch only after the hello proves that descriptor is a live authenticated bridge; a stale descriptor is ignored. That hello does not send a status request. Discovery fails if any such live ceiling differs, even when another live session matches. A hello that
never sends its authenticated frame does not hold the bridge accept loop.
At most 8 connection threads run. A further accept is closed, and a failure to start a thread closes that socket without stopping the listener. A status `completed_connection` is the longest prefix of accepted connections that have terminated. It does not treat an earlier connection as finished because a later status reached the command lock first. Scalar values in one Cutter reply are encoded in bounded batches.
A command reply that does not fit keeps its completion state and document
generation, and reports an oversized path as unknown. Cutter response frames use this same ceiling and
also exclude the terminating LF. A command response the client discards because it exceeds that ceiling stays an unknown execution and sets `output_truncated`, so Evidence records the omitted output. Hopper response reads are unchanged.
Each bridge request waits 25000 ms. The Cutter hello frame still must arrive
within 1 second. The authenticated command frame is read with one second per
mebibyte of `REA_BRIDGE_MAX_REQUEST_BYTES`, and that read never waits longer
than the same 25000 ms. Discovery admits at most 256 descriptor
candidates and reads and probes at most eight concurrently. A larger directory
reports `bridge_directory_capacity_exceeded`. This release has no runtime
override for the 25000 ms request deadline or the 256-candidate discovery
budget. Those limits do not follow `REA_BRIDGE_MAX_REQUEST_BYTES`.

Terminal receipts are recovered before another command, including from a new CLI
invocation. A signed status response also confirms completion of older bridge
connections after its UI dispatch, preserving recovery proof for a caller whose
receipt another caller has acknowledged. Neither receipt recovery nor a status
probe retries the original command. Failed acknowledgements remain pending and
block new commands until they can be retried successfully. Status proof failures
identify `cutter_command` and retain `status` in
`details.diagnostics.auxiliary_operation`; malformed proof still blocks dispatch.
Descriptor failures likewise retain the requesting operation through cleanup.
If a completion-proof read fails while an earlier command is unresolved, retry
admission preserves both errors and their independently owned resources. Releasing
one owner does not settle the other, and the command is not replayed to recover proof.
Command admission reports typed cancellation and treats the caller's abort reason
as opaque metadata, without inferring cleanup ownership from it. A generation
mismatch is an input correction only when the authenticated reply confirms
`not_started`. Missing or ambiguous execution state retains the command's
completion uncertainty until terminal proof arrives, even if the reply names a
generation error.

## Configuration and coverage

The optional `REA_OBJDUMP_COMMAND`, `REA_GDB_COMMAND`, `REA_RIZIN_COMMAND`, and `REA_R2_COMMAND` values select executable names or paths; otherwise REA searches `PATH`. Values are passed directly to process spawning, not expanded as shell command lines. A host executable launch refusal preserves the selected command and host error code, with recovery through the corresponding command setting, PATH, or execute/search permissions. GDB does not retry that refusal with MI2; its MI2 fallback applies to protocol initialization failures. Provider versions and capabilities remain unknown until observed from the installed tool and verified in the corresponding real-provider lane.

Provider capture limits are separate from the MCP response budget. A result that fits the provider limit may still exceed the default 10 MiB MCP response budget and return a transport `resource_constraint`. Configure `REA_MCP_MAX_RESPONSE_BYTES` to match a larger client receive buffer when that client supports one; otherwise use retained Evidence/export or complete CLI JSON output. See [MCP response limits](reference/mcp-contracts.md#tool-results).
