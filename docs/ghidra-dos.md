# DOS MZ analysis with Ghidra

REA can analyze DOS MZ executables through the bring-your-own Ghidra adapter.
The Linux x64 verification lane exercises actual 16-bit disassembly and
decompilation through the CLI and stdio MCP. It requires the same Ghidra
12.1.4 and 64-bit JDK 21 installation as other Ghidra sessions; no DOS emulator
or cross-compiler is required.

## Open and inspect

```bash
rea inspect /absolute/path/to/legacy.exe --provider ghidra --json
rea search /absolute/path/to/legacy.exe entry --kind procedures --provider ghidra --json
rea instructions /absolute/path/to/legacy.exe entry --provider ghidra --json
rea function /absolute/path/to/legacy.exe entry --provider ghidra --json
```

Use an observed procedure name or address from discovery when the target does
not name its entry function `entry`. MCP uses `open_binary`, `list_procedures`,
`procedure_info`, `read_function_instructions`, and `analyze_function` with the
same admitted target and provider semantics.

The classifier validates MZ page counts, initialized module length, header and
relocation-table bounds, relocation destinations, and the initialized entry
point. It distinguishes DOS load-module and relocation bytes from the Windows
new-header field. PE remains PE; NE, LE, and LX declarations are explicitly
unsupported. A damaged declared Windows header does not silently become DOS.
Inventory classification returns `unknown` when its bounded prefix cannot
establish the format; this is distinct from the complete target admission check.

Ghidra imports a private target snapshot with `MzLoader`, language
`x86:LE:16:Real Mode`, and compiler specification `default`. These settings,
the fixed Ghidra load segment `0x1000`, and the linear address convention are
committed in the analysis profile. The handshake rejects language or compiler
drift. Closing the session deletes the temporary project and snapshot.

The profile also commits `function_body_evidence: complete-inclusive-ranges-v1`,
so snapshots from older length-only Ghidra results do not satisfy the current
profile.

## Addresses and function extent

Returned default-space addresses are linear byte coordinates. A Ghidra
segment:offset address has linear value `segment * 16 + offset`; multiple
segment aliases can identify the same byte. REA accepts the returned linear
address for subsequent lookups and leaves instruction decoding context with
Ghidra. These coordinates are analysis load addresses, not file offsets or
observations of a running DOS system.

`procedure_info` and function dossiers include `body` evidence:

```json
{
  "available": true,
  "provenance": "ghidra-function-body-address-set",
  "ranges": [
    { "start": "0x10000", "end": "0x1000d" },
    { "start": "0x10060", "end": "0x10065" }
  ],
  "total_bytes": 20,
  "span_bytes": 102,
  "non_contiguous": true,
  "contains_entry": true
}
```

Each end is **inclusive**. `total_bytes` counts the complete observed
AddressSet; `span_bytes` measures its enclosing span and is null across address
spaces. Gaps and shared tails must not be treated as owned bytes. This is
Ghidra's database observation, not a proof of original source ownership or
exhaustive code discovery. Providers that do not report complete ranges return
`available: false` and an explicit reason.

## Coverage boundaries

Static decompilation does not execute the target or emulate BIOS, DOS
interrupts, device ports, or self-modifying code. PC-98 hardware behavior and
recovered calling conventions can remain uncertain; provider pseudocode and
diagnostics are retained for analyst review.

For a packed executable, importing the original can analyze its unpacking
stub. Analyze a separately prepared unpacked copy to inspect the original
program's recovered code. Retain both artifact digests and the transformation
evidence; REA never silently replaces the admitted target. Appended overlays
are separate from the initialized MZ module. Raw COM files and DOS extenders
without an admitted MZ real-mode entry are outside this import boundary.

DOS MZ is available through Ghidra, with no Hopper support claim. It is outside
the Windows native PE P0 boundary. macOS DOS verification remains unverified.

## Real verification

```bash
npm run verify:ghidra:dos
```

The lane generates a small public fixture from source at runtime. It verifies
16-bit instruction bytes, a near call, a segment-relocated far call, actual
decompilation, disjoint function ranges, stable CLI/MCP observations, unchanged
input bytes, and session/process cleanup. It does not require external
executable fixtures, an emulator, or an existing analysis database.

Provider p-code representations can contain process-specific address-space selector
tokens. The lane preserves those reported values and compares stable dossier
observations rather than asserting cross-process identity of raw p-code.
