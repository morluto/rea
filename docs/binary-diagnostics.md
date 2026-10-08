# Offline binary diagnostics

`inspect_binary_layout` / `inspect-binary-layout` answers what an explicit
file contains: section/segment layout, original symbols/relocations, static
linkage names and mitigation indicators. It works without an active Hopper,
Ghidra or IDA target. CTF is one possible use; crash triage, compatibility and
ordinary binary inspection use the same modular capability.

## Bring your own engine

Initial real verification covers **Linux x64, ELF64 x86-64 little-endian
EXEC/DYN/REL**. Provide an absolute Python executable whose environment already
contains unchanged pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2:

```sh
REA_PWNTOOLS_PYTHON=/absolute/isolated-env/bin/python \
  rea inspect-binary-layout ./selected.elf --json
```

```json
{
  "name": "inspect_binary_layout",
  "arguments": { "path": "/artifacts/selected.elf" }
}
```

REA never installs Python, packages or GDB, changes a user init file, launches
the selected object as a host process, or requests runtime library resolution. The Python process
uses isolated mode and an owned cache. Exact upstream profiles are recorded in
[upstream provenance](../third_party/pwntools/README.md).

## Interpreting results

- Artifact path, SHA-256 and size identify original selected bytes. All parsing
  reads an owned stable snapshot; the original is unchanged.
- Addresses, offsets, lengths and flags are hexadecimal strings. A linked
  address is not a runtime address. Runtime load base remains null. A zero
  EXEC/DYN entry means absent; a relocatable entry is not applicable.
- Each symbol retains its table and entry index. Its reported value can mean
  undefined, alignment, absolute value, no address, unknown section index,
  section offset, TLS offset or linked virtual address. Duplicate names remain
  separate entries. SHN_XINDEX remains unresolved in the selected upstream
  representation; its external index table is not silently treated as resolved.
- Relocatable objects have section-relative relocations and no executable entry
  claim. Signed REL/RELA relocation addends are decimal strings. Packed RELR
  tables retain full original bytes and upstream-decoded offsets as derived
  evidence, with per-offset packed-word locations and implicit addends unknown.
  Overall relocation inventory completeness remains unknown.
  A relocatable SHN_UNDEF target or inactive SHT_NULL header remains an explicit
  unknown with the original reported section index and offset.
- REL/RELA symbol references retain their original table and entry indices.
  Positive indices resolve through a validated symbol table; symbol index zero
  means a zero symbol value without a table lookup, including when no table is
  linked. Malformed references fail with the affected section and symbol index.
- Name display strings use UTF-8 replacement for opaque bytes, including
  sectionless dependency names and interpreter paths. Raw name
  bytes and string-table ranges retain observed identity where resolvable;
  ranges include the terminating NUL and base64 bytes exclude it.
- NOBITS and NULL sections provide no file bytes. Reported file-backed ranges
  are checked against snapshot size again at the public boundary. PT_NULL payload
  fields are unused: reported numbers remain, file backing is none and interpreted
  permissions are null. Segments with zero file size also have no file bytes.
- Sectionless dynamic images still report dependency names with raw bytes and
  file locations where uniquely mapped. Missing symbol/relocation section tables
  do not establish that those runtime tables are absent.
  Upstream RELRO/canary heuristics rely on sections and can be incomplete in
  this case; their reported candidates retain an explicit coverage limitation.
- DT_NEEDED/PT_INTERP are reported names, not resolved runtime paths. GOT/PLT
  maps are derived convenience views and may collapse aliases. PLT inference
  can emulate selected instructions in Unicorn; its outputs are static candidates.
  Exec syscall tracing observes host process launches. Map completeness
  remains unknown and original upstream warnings are returned inline.
- Canary, PIE, NX, executable-stack and RELRO are static inferences. NX and
  executable-stack are separate upstream indicators: on x86-64 an executable
  stack can accompany an unknown (`null`) NX indicator. ET_DYN can be a shared
  library, and an absent canary symbol does not prove every function unprotected.

Complete results have a 32 MiB input, 64 MiB reply, 1 MiB combined diagnostics
and 30-second owned command deadline. Python lowers resource soft limits to at most 3 GiB virtual address space,
30 CPU seconds and 64 MiB file output. Inherited tighter soft/hard limits are
retained, and the effective values are returned in the result limitations. Virtual address space is not RSS;
Unicorn needs a large virtual map. Limits fail with no partial success, and
owned process/root cleanup completes independently of cancellation.

Core files, GDB session/state/control, optional pwndbg enrichment and instruction
inspection are separate increments tracked by #969. This increment makes no
real support claim for those features or other operating systems/architectures.

Typed decoder failures retain bounded `captured_output` (stdout, stderr and an
explicit truncation flag) alongside the original failure category and reason.
Successful `diagnostics` also exposes the supervisor's `truncated` flag. Output
beyond the complete diagnostic budget is rejected, including when the decoder
writes a valid reply; cleanup and late cancellation reuse the observed flag.
Memory allocation failures use `resource_constraint`, with effective resource
limits (or an explicit unknown) and memory-specific recovery guidance. A
MemoryError alone does not establish the exact failed allocation or that a
particular budget was exhausted. Invalid undersized symbol entries are rejected
before REA reports source ranges for them.
The bridge reserves 1 MiB to report allocation failures. If even error reporting
or serialization fails with MemoryError, its reserved exit status preserves the
resource classification with unknown effective limits. Signal termination alone
is never classified as observed memory exhaustion.
The small bootstrap also covers catchable MemoryError during adapter imports,
compilation and initialization. Python interpreter startup failures before the
bootstrap runs retain their observed process diagnostics without guessed causes.
SIGXCPU retains a CPU resource diagnostic and CPU-specific recovery advice.
Observed EFBIG writes or SIGXFSZ termination retain a file-size resource
diagnostic and file-size-specific recovery advice. If a tight file limit also
prevents writing the limit record, effective values remain unknown.
The bridge records actual limits in owned storage before analysis; missing or
malformed limit reports remain unknown with their read failure preserved. A
received signal alone does not establish its exact cause. Dynamic tags require
a complete DT_NULL inside PT_DYNAMIC; interpreter names and ranges end at the
first NUL, with any padding still represented by the original segment range.
