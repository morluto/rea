# HarmonyOS Ark bytecode analysis

REA analyzes HarmonyOS Ark bytecode (`.abc`, Panda bytecode) and HarmonyOS
application packages (`.hap`) with a caller-supplied
[xpanda](https://github.com/asmjmp0/xpanda) checkout. xpanda is a
pure-TypeScript decompiler; REA never downloads, installs, updates or bundles
it. REA verified this integration with xpanda 3.6.0 and admits 2.x checkouts
for the original operations; `rea doctor` and each result's limitations report
a configured release as unverified when it differs. Operations added in 3.x
are reported unavailable when the configured release does not advertise them.

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
installed. REA launches the checkout's own MCP server as a long-lived, owned
child process and retires it after 60 seconds of inactivity, and stops it on
shutdown. It resolves the entry by layout:
`packages/xpanda-mcp/src/server.ts` for the 3.x workspace checkout, and
`src/mcp/server.ts` for 2.x. The checkout's root `package.json` version selects
admission: 2.x and 3.x are admitted, other majors are refused with a typed
capability error.

| Setting           | Default         | Meaning                                                                                  |
| ----------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `REA_XPANDA_ROOT` | none (required) | Absolute path of the xpanda checkout. Presence enables the HarmonyOS Ark bytecode tools. |

Linux and macOS are supported. Windows process-tree ownership for xpanda is not
verified.

## What it answers

| Tool                             | Question                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_harmony_abc`            | Header facts: bytecode version, checksum, size, class counts, LNP count, class-name preview.                                       |
| `list_harmony_abc_classes`       | Demangled class inventory with method/field counts, external flags, filter, paging.                                                |
| `inspect_harmony_abc_class`      | One class's superclass, access flags, fields with types, methods with shorty prototypes, imports and exports.                      |
| `decompile_harmony_abc_class`    | One class as producer-generated JavaScript, with degraded/truncation flags.                                                        |
| `decompile_harmony_abc_method`   | One method, constructor, getter or setter only, avoiding a whole class in context.                                                 |
| `decompile_harmony_abc`          | Every class into an absent directory, one file per demangled class name; per-class failures are reported.                          |
| `disassemble_harmony_abc_method` | One method's basic-block bytecode listing with pc, operands, jump targets and try/catch attribution.                               |
| `search_harmony_abc_strings`     | String-pool matches with file offsets, substring or regular expression, paged.                                                     |
| `search_harmony_abc_symbols`     | Class, method and field name matches without decompiling, with kind, class filter, regex and paging.                               |
| `search_harmony_abc_code`        | Matches in decompiled JavaScript with class, line, method and optional context lines; scanned/skipped/failed classes are reported. |
| `trace_harmony_abc_references`   | References to a class, method, field or string, from bytecode and optionally decompiled source; paged with scan coverage.          |
| `build_harmony_abc_call_graph`   | Callers, callees or both around one method, bounded by depth and node count, with an optional Mermaid rendering.                   |
| `inspect_harmony_hap_abc`        | One `.abc` entry of a `.hap` package: runtime (dynamic or static), bytecode version and class-name preview.                        |
| `inspect_harmony_hap_resources`  | The package resource table (`resources.index`, Restool or RestoolV2) by name, type, qualifier or ID, paged with totals.            |

Every result is inline Evidence bound to the selected file: subject format
`abc` for bytecode, or `hap` for a package; the analyzed bytes' SHA-256 (taken
from a private staged copy), the admission-copied engine digest over the
checkout's manifests and source trees, producer version, and explicit
limitations.

```sh
rea inspect-harmony-abc app.abc --json
rea list-harmony-abc-classes app.abc --filter com.example --limit 100
rea inspect-harmony-abc-class app.abc com.example.EntryAbility
rea decompile-harmony-abc-class app.abc com.example.EntryAbility
rea decompile-harmony-abc-method app.abc com.example.EntryAbility onCreate
rea decompile-harmony-abc app.abc /tmp/app-decompiled
rea disassemble-harmony-abc-method app.abc com.example.EntryAbility --method-name onCreate
rea search-harmony-abc-strings app.abc "https://" --limit 50
rea search-harmony-abc-symbols app.abc --query onCreate --kind method
rea search-harmony-abc-code app.abc "https://" --class-filter com.example
rea trace-harmony-abc-references app.abc --target-type method --target onCreate --owner-class com.example.EntryAbility --source
rea build-harmony-abc-call-graph app.abc com.example.EntryAbility onCreate --graph-format mermaid
rea inspect-harmony-hap-abc app.hap --entry ets/modules.abc
rea inspect-harmony-hap-resources app.hap --name app_name --type string
```

MCP exposes the same operations with identical validation and Evidence. An
operation whose producer tool is absent from the configured release fails with
a capability error that names the missing tool and the verified release.

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
- **Single-class and single-method transfers are capped at 50,000 characters**
  by the producer and report `truncated`; use whole-file decompilation for the
  remainder.
- **Whole-file decompilation is a producer loop.** Classes without output are
  counted as `skipped`, per-class failures as `failed`, and coverage becomes
  `partial`; at most 200 written names are returned. The producer writes into a
  private runtime root, and REA publishes only regular files under the selected
  absent directory; linked or escaping entries and a written-count mismatch are
  refused instead of overwriting files.
- **String-pool search requires a full disassembly pass per query.** Methods
  that fail disassembly are absent from the pool without individual reporting.
- **Symbol search reads metadata only.** It does not prove that a method has a
  body; inspect the class or decompile before relying on a name.
- **Code search decompiles on demand.** It stops after the selected class
  budget and reports scanned, skipped, failed and truncated classes; use
  whole-file decompilation for exhaustive searches.
- **Cross-references and call graphs differ by runtime.** Static ArkTS bytecode
  references are exact instruction operands. Dynamic bytecode keeps method call
  targets in the accumulator, so bytecode cross-references cannot see direct
  call edges; enabling source scanning recovers call sites from decompiled
  output but can still miss indirect calls, and both report scan budgets and
  disassembly failures.
- **HAP resource rows are parsed declarations**, not resolved runtime values.
  The resource table format, qualifier vocabulary and value formatting belong
  to the producer.
- **Input admission copies the selected bytes into a private runtime root** and
  verifies the copy against a stable read of the source. The 256 MiB admission
  bound is REA's, not the producer's.
- The TypeScript loader, Node runtime and installed producer dependencies are
  not independently attested; the engine digest covers the root manifest and
  the `src` tree (2.x) or each workspace's manifest and `src` tree (3.x). The
  producer's own `initialize` identity is checked, but its reported version
  (`1.0.0`) is not the package version.

## Verification lane

```sh
REA_XPANDA_ROOT=/absolute/path/to/xpanda npm run verify:xpanda
```

The lane runs the compiled CLI and the SDK-connected stdio MCP server against a
real xpanda checkout. It exercises header inspection, class listing, class
metadata, single-class and single-method decompilation, method disassembly,
string, symbol and code search, cross-references, call graphs, whole-file
decompilation into a fresh directory, CLI/MCP parity of header and inventory
facts, and an absent-class typed failure. It defaults to the checkout's
`md5.abc` sample (`test/resources` for 2.x, `packages/xpanda-core/test/resources`
for 3.x); set `REA_XPANDA_TEST_ABC` to verify another file. HAP entry and
resource checks run when `REA_XPANDA_TEST_HAP` names a package or a documented
sample exists, and are skipped otherwise. The lane proves integration behavior
for the supplied checkout; it does not certify xpanda's decompilation fidelity
for arbitrary bytecode versions.
