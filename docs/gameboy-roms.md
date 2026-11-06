# Game Boy and Game Boy Color cartridges

Open an explicitly selected cartridge ROM with the Ghidra provider. REA uses the
Sharp **SM83** CPU language (also commonly called LR35902), not the Z80 language.
The filename extension does not select the format.

```bash
rea inspect-native-load-image /absolute/path/game.gbc \
  --target-format gameboy-rom --provider ghidra --json
rea decompile /absolute/path/game.gb --procedure 0x100 \
  --target-format gameboy-rom --provider ghidra --json
```

For MCP, open the same file with:

```json
{
  "path": "/absolute/path/game.gb",
  "format": "gameboy-rom",
  "provider_id": "ghidra"
}
```

Then use `inspect_native_load_image`, `list_procedures`, `analyze_function`,
`procedure_pseudo_code`, `inspect_native_instruction`, `read_bytes`, and the
normal reference tools. Omit `architecture` and `entry_point`: the format fixes
SM83 and cartridge entry `0x100`.

## Prerequisites

Supply a supported Linux or macOS Ghidra installation and full JDK as described
in [installation](installation.md#ghidra), with an installed language declaring
`SM83:LE:16:default` and compiler specification `default`. Stock Ghidra does not
include this CPU. REA reports the missing prerequisite before importing a ROM.
It does not install or modify Ghidra or Java.

[GhidraBoy](https://github.com/Gekkio/GhidraBoy) supplies an Apache-2.0 SM83
SLEIGH language. Its published extension targets older Ghidra versions; do not
assume an old prebuilt extension works with Ghidra 12. Compile the language for
your Ghidra version and install its processor module under
`GHIDRA_INSTALL_DIR/Ghidra/Processors` or `GHIDRA_INSTALL_DIR/Ghidra/Extensions`.
User-profile-only extensions are not admitted by REA's isolated installation
catalog. This route uses REA's cartridge mapping script rather than the
GhidraBoy Kotlin loader. The language source and binaries are not bundled with
REA. Other language IDs and compiler conventions are not selected implicitly.

## ROM and bank interpretation

The header declares the mapper and ROM capacity. The complete file must match
that capacity exactly: truncated images, copier headers and appended padding
are rejected. ROM-only/ROM+RAM, MBC1, MBC2, MBC3 and MBC5 cartridge declarations
are admitted for static physical-bank inspection. Other mappers, boot ROMs,
GBA images, and embedded SGB SNES code need separate workflows.

Header/logo inconsistencies are retained as warnings, so a patched header does
not prevent explicit static inspection. The global checksum is retained as a
header declaration, not verified. None of these facts establishes bootability.

- Physical bank 0 occupies `0x0000..0x3fff`.
- Physical bank 1 occupies `0x4000..0x7fff` in the default analysis space.
- Each later bank has its own overlay: bank 2 is `ROM_002:0x4000`, bank 3 is
  `ROM_003:0x4000`, through bank 511 at `ROM_1ff:0x4000`.

`inspect_native_load_image` compares every bank's mapped bytes, file offset,
address, overlay status and read/execute permissions against the immutable ROM
snapshot. It checks complete original/modified source identity and entry `0x100`.
The reported `verified` status covers those checks; it does not verify runtime
mapper behavior, RAM contents or hardware state. ROM bytes remain unchanged and
Ghidra projects are ephemeral.

RAM and I/O windows are mapped as uninitialized storage. The echo window does
not model RAM aliasing; cartridge RAM may be absent. CGB RAM banks are not
inferred from a ROM header. Bank switching, far-call conventions, MBC1 remapping
of the lower ROM window, dynamic code, interrupt execution and timing remain
unknown. A call into `0x4000` is not proof that physical bank 1 was active.
Decompiler register arguments, calling conventions and computed jumps are
heuristic.

## Analyze code in another bank

Only cartridge entry `0x100` is automatically seeded. To select additional known
code, set `REA_GHIDRA_SEED_FILE` before opening the target. It accepts ordinary
hex addresses or encoded address-space-qualified addresses, using the same
coordinate spelling as REA's native analysis tools:

```text
0x4000	function	bank_one_entry
ROM_002:0x4000	function	bank_two_entry
```

The separators above are literal tab characters. Seeds are caller assertions;
their digest and outcomes are retained in the analysis profile. Unknown spaces
are reported as unmapped seeds. Use `ROM_002:0x4000` as the procedure address for
bank 2, or select its unique source coordinate `file-offset:0x8000`. REA does not
invent cross-bank call edges or disassemble every data bank as code.

## Verification

```bash
GHIDRA_INSTALL_DIR=/absolute/path/ghidra-with-sm83 \
  JAVA_HOME=/absolute/path/jdk npm run verify:ghidra:gameboy
```

The verifier generates its own DMG ROM-only and four-bank CGB MBC5 cartridges.
It checks the CLI and MCP routes, all bank digests, SM83-specific LDH/SWAP
instructions, overlay function seeds, pseudocode, unique file-offset selection,
rejected truncation preserving the active session, original ROM preservation,
and process/runtime cleanup. It does not execute a cartridge or test a
commercial ROM corpus. Windows Ghidra P0 does not admit this lane.
