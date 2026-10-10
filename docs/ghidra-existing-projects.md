# Existing local Ghidra projects

REA can process one Program that already exists in a local Ghidra project. This
mode does not import the original executable again and does not choose a loader,
processor, language, compiler specification, memory map, or analyzer preset.
Those facts come from the selected Program stored by Ghidra.

## Open one Program

Pass the absolute `.gpr` marker path, the exact project name without the suffix,
and the absolute Ghidra domain-file path:

```json
{
  "path": "C:\\research\\Firmware.gpr",
  "provider_id": "ghidra",
  "existing_project": {
    "project_name": "Firmware",
    "program": "/folder/program.bin"
  }
}
```

The marker must be named `<project_name>.gpr` and its sibling backing store must
be `<project_name>.rep`. Program selection is exact: wildcards, parent traversal,
and heuristic name matching are rejected. A nested Program uses its full domain
path, such as `/folder/program.bin`.

## Isolation and identity

Before Ghidra starts, REA walks the `.gpr` marker and every regular file in the
`.rep` tree in stable relative-path order. Symbolic links and unsupported
filesystem members are rejected. The resulting SHA-256 commits both names and
bytes.

REA then copies the complete project into its private per-session runtime and
recomputes the commitment. A mismatch fails the open as a changed artifact.
Ghidra receives only the copied project location and runs:

```text
analyzeHeadless <private-project-root> <project-name>/<folder> \
  -process <program-name> -noanalysis -readOnly ...
```

The original `.gpr` and `.rep` are never opened by the Ghidra process. Ghidra's
document path is authenticated during the bridge handshake. Closing,
cancellation, or startup failure removes the private project through REA's
ordinary owned-runtime cleanup.

`-readOnly` discards Program changes at headless exit. Copy-on-open is an
additional boundary that also prevents original project lock, journal, and
metadata changes. On Windows, database-mutation tools remain unavailable under
the existing P0 policy even though the project is copied.

## Address and analysis semantics

REA addresses are byte offsets. This matters for processors whose Ghidra address
space has an addressable unit larger than one byte. For example, a PIC24 Program
counter value must be converted to its ROM byte offset before it is passed to a
REA address input. Non-default spaces are explicit, such as `ram:0x27d2`.

The bridge uses Ghidra's byte-offset API when parsing these values, so an address
returned by REA round-trips on non-byte-addressed processors. Assembly operand
text remains Ghidra-specific and may display the processor's native word
coordinate.

Existing-project mode passes `-noanalysis`: functions, references, symbols,
memory blocks, and decompiler state therefore reflect the selected stored
Program. MCP success proves the connection and observation only. Correct
instruction decoding and semantics still require an independent oracle suitable
for the target architecture.

## Scope and limitations

- Local `.gpr`/`.rep` projects are supported. Ghidra Server repositories are not.
- The complete project is copied for each fresh provider session; very large
  projects therefore need corresponding temporary disk space and startup time.
- A project that changes during the copy is rejected. Close the Ghidra GUI or
  retry after writers are idle.
- Load-image observations are available, but REA's independent format-specific
  attestation currently remains limited to DOS MZ and explicit DOS COM.
- Existing import flows remain unchanged. Omit `existing_project` to retain
  header-based executable import behavior.
