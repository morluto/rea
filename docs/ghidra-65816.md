# Ghidra 65816 / SNES ROM analysis

REA admits `65816` as a raw-only architecture so single-file Super Nintendo ROM dumps (`.sfc` / `.smc`) can be opened and analysed through the existing Ghidra provider.

## Requirements

- Ghidra with a community 65C816 / 65816 processor extension installed (upstream Ghidra does not ship one). Common options include:
  - https://github.com/joshleaves/ghidra-snes
  - https://github.com/achan1989/ghidra-65816 (archived)
- A caller-supplied single-file ROM that you own or are authorised to analyse.

### Installing the extension

REA runs Ghidra in an isolated environment and does **not** search the user's normal Ghidra profile or home directory for extensions.

Place the extension under the selected Ghidra installation:

```text
$GHIDRA_INSTALL_DIR/Ghidra/Extensions/<extension-name>
```

Then restart any REA session so the isolated runtime picks it up. See also `docs/ghidra-psp.md` for the same isolated-extension pattern.

## Usage

Open the ROM as a raw binary and explicitly select the architecture and entry point:

```bash
rea analyze /path/to/game.sfc --target-format raw-binary --architecture 65816 --entry-point 0x8000
```

Or via MCP `open_binary` with:
```json
{
  "path": "/path/to/game.sfc",
  "format": "raw-binary",
  "architecture": "65816",
  "entry_point": "0x8000"
}
```

Common starting load addresses (for a headerless image whose entry is at file offset 0):
- LoROM: `0x8000` (first bank only; later banks require a real banked map)
- HiROM: do **not** treat `0x8000` as a general load base for a full HiROM dump. A contiguous raw load cannot reproduce HiROM's bank layout. Prefer a pre-mapped or single-bank extract, or supply a base that matches the region you actually want to analyse.

REA does not auto-detect LoROM vs HiROM or interleave multi-file ROM sets in this version. Supply the correct load address yourself.

### Load base vs reset entry

The raw-binary path uses a single `entry_point` value both as the load base (where file offset 0 is mapped) and as the seeded entry function. On a real SNES ROM the reset vector often points somewhere other than the first ROM byte. Using `0x8000` maps the file correctly but invents the entry; supplying the real reset address shifts every file-backed address. For v1, prefer images where the desired entry is at file offset 0, or accept the limitation.

## Important: SMC copier header

Many `.smc` files contain a 512-byte copier header at the start. REA's raw-binary loader maps the file contiguously from the given entry point; it does **not** strip this header.

If you load a headered `.smc` at `0x8000` without removing the first 512 bytes, every address will be shifted by `0x200`. Prefer a headerless `.sfc` (or strip the 512-byte header yourself) before loading.

## Limitations

- The real provider path (with a community 65816 extension installed) has not yet been verified end-to-end. Stock Ghidra 12.1.4 has no 65816 language; the launch stops with `Unsupported language: 65816:LE:24:default` until an extension supplies one.
- Raw 65816 is not supported on Windows hosts. The provider reports `target_format_unsupported` for non-PE raw architectures other than 6502.
- No automatic memory map / LoROM-HiROM detection. A simple contiguous raw load does not implement SNES banked addressing; addresses beyond the first bank may not match a real cartridge mapping.
- `0x8000` is not a correct general load base for a full HiROM image.
- No multi-file or interleaved ROM support.
- No automatic SMC header stripping.
- Single `entry_point` serves as both load base and entry; no separate base/entry values.
- No emulation.
- Decompilation quality depends on the installed 65816 SLEIGH module and on correctly setting the M/X flag state in Ghidra for the region being analysed.
- Analysis is read-only.
- Actual decompilation requires a compatible Ghidra 65816 language extension; REA only admits the architecture and hands the bytes to Ghidra.

## Related

- Issue: https://github.com/morluto/rea/issues/4794
- Existing raw-binary path used by `6502` and `m68k`.
- Canonical raw-binary guide: `docs/raw-binary.md`.
