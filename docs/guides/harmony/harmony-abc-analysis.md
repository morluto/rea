# HarmonyOS Ark bytecode analysis

REA analyzes HarmonyOS Ark bytecode (`.abc`, Panda bytecode) with a
caller-supplied [xpanda](https://github.com/asmjmp0/xpanda) checkout. xpanda is
a pure-TypeScript decompiler; REA never downloads, installs, updates or bundles
it. REA verified this integration with xpanda 2.1.0 and admits other 2.x
checkouts, reporting them as unverified in `rea doctor` and in each result's
limitations.

xpanda parses and renders bytecode; it never executes it, and neither does REA.
This is the dedicated HarmonyOS provider that the package inventory's
limitations previously deferred (see
[HarmonyOS package inventory](./harmony-analysis.md), roadmap #1431).

## Configure

```bash
cd /absolute/path/to/xpanda && npm ci
export REA_XPANDA_ROOT=/absolute/path/to/xpanda
rea doctor --provider xpanda
```

`REA_XPANDA_ROOT` must be an absolute path to a checkout with its dependencies
installed. REA launches the checkout's own MCP server
(`node --import tsx src/mcp/server.ts`) as a long-lived, owned child process,
retires it after 60 seconds of inactivity, and stops it on shutdown. The
checkout's `package.json` version selects admission: 2.x is admitted, other
majors are refused with a typed capability error.

| Setting           | Default         | Meaning                                                                                      |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `REA_XPANDA_ROOT` | none (required) | Absolute path of the xpanda checkout. Presence enables the six HarmonyOS Ark bytecode tools. |

Linux and macOS are supported. Windows process-tree ownership for xpanda is not
verified.

## What it answers

| Tool                             | Question                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `inspect_harmony_abc`            | Header facts: bytecode version, checksum, size, class counts, LNP count, class-name preview.              |
| `list_harmony_abc_classes`       | Demangled class inventory with method/field counts, external flags, filter, paging.                       |
| `decompile_harmony_abc_class`    | One class as producer-generated JavaScript, with degraded/truncation flags.                               |
| `decompile_harmony_abc`          | Every class into an absent directory, one file per demangled class name; per-class failures are reported. |
| `disassemble_harmony_abc_method` | One method's basic-block bytecode listing with pc, operands, jump targets and try/catch attribution.      |
| `search_harmony_abc_strings`     | String-pool matches with file offsets, substring or regular expression, paged.                            |

Every result is inline Evidence bound to the selected `.abc` file: subject
format `abc`, the analyzed bytes' SHA-256 (taken from a private staged copy),
the admission-copied engine digest over the checkout's `package.json` and `src`
tree, producer version, and explicit limitations.

```sh
rea inspect-harmony-abc app.abc --json
rea list-harmony-abc-classes app.abc --filter com.example --limit 100
rea decompile-harmony-abc-class app.abc com.example.EntryAbility
rea decompile-harmony-abc app.abc /tmp/app-decompiled
rea disassemble-harmony-abc-method app.abc com.example.EntryAbility --method-name onCreate
rea search-harmony-abc-strings app.abc "https://" --limit 50
```

MCP exposes the same operations with identical validation and Evidence.

## Interpretation boundaries

- **Decompilation is producer-generated JavaScript, not recovered source.**
  Methods beyond xpanda's structural-analysis limits — including methods using
  unimplemented conditional jumps (the `jeq`/`jne` family) — degrade to linear
  output carrying `decompiler_goto` labels. The `degraded` flag and
  `degraded_classes` list report this; absence of the flag is the producer's
  claim, not REA's independent verification.
- **Instruction rendering belongs to xpanda.** Disassembly listings are
  preserved verbatim behind the parsed method header; REA does not re-derive
  control flow from them.
- **Single-class transfers are capped at 50,000 characters** by the producer and
  report `truncated`; use whole-file decompilation for the remainder.
- **Whole-file decompilation is a producer loop.** Classes without output are
  counted as `skipped`, per-class failures as `failed`, and coverage becomes
  `partial`; at most 200 written names are returned.
- **The string pool requires a full disassembly pass per query.** Methods that
  fail disassembly are absent from the pool without individual reporting.
- **Input admission copies the selected bytes into a private runtime root** and
  verifies the copy against a stable read of the source. The 256 MiB admission
  bound is REA's, not the producer's.
- The TypeScript loader, Node runtime and installed producer dependencies are
  not independently attested; the engine digest covers `package.json` and the
  `src` tree only. The producer's own `initialize` identity is checked, but its
  reported version (`1.0.0`) is not the package version.

## Verification lane

```sh
REA_XPANDA_ROOT=/absolute/path/to/xpanda npm run verify:xpanda
```

The lane runs the compiled CLI and the SDK-connected stdio MCP server against a
real xpanda checkout. It exercises header inspection, class listing, single-class
decompilation, method disassembly, string search, whole-file decompilation into
a fresh directory, CLI/MCP parity of header and inventory facts, and an
absent-class typed failure. It defaults to the checkout's `test/resources/md5.abc`
sample; set `REA_XPANDA_TEST_ABC` to verify another file. The lane proves
integration behavior for the supplied checkout; it does not certify xpanda's
decompilation fidelity for arbitrary bytecode versions.
