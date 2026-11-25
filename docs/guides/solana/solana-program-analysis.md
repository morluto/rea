# Solana sBPF program analysis

`analyze_solana_program` / `analyze-solana-program` analyzes one Solana
program (sBPF ELF) from an explicitly selected source: a local ELF file, or a
program id fetched read-only through Solana JSON-RPC. It does not require an
active native binary target, never executes the program, and never builds,
signs, or broadcasts a transaction.

```sh
rea analyze-solana-program --path ./pump_amm.so --json
rea analyze-solana-program --program-id pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA --out-dir ./pump_amm --json
rea analyze-solana-programs --items "[{\"path\":\"$PWD/pump.so\"},{\"path\":\"$PWD/pump_amm.so\"}]" --out-dir ./batch --json
rea analyze-solana-programs --dir ./captures --out-dir ./batch --json
```

Paths inside `--items` are JSON values validated by the tool contract, so
they must be absolute; `--dir` and `--out-dir` are resolved against the
current directory.

`analyze_solana_programs` / `analyze-solana-programs` runs the same
single-program workflow over a mixed list of local ELFs and program ids
(`items`, and/or `dir` for a directory of `.so` files, at most 64 after
expansion) with bounded concurrency (default 4, cap 8). The batch
`out_dir` must be absent or empty. Each item lands in `<out_dir>/<name>/`
with the single mode's artifacts, where `<name>` is a sanitized, unique
directory name (never `.`/`..`, never a reserved root file such as
`index.json` or `receipts.json`); one bad item yields an error entry and
never sinks the batch. An unreadable `dir` is an input or access error.
`<out_dir>/index.json` (created exclusively) records, per item: source,
artifact SHA-256, slot when fetched, handler-candidate count, dispatch
coverage, per-item analysis path, and status or error.

```json
{
  "name": "analyze_solana_program",
  "arguments": {
    "program_id": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "out_dir": "/artifacts/pump_amm"
  }
}
```

## Intake

- `path` (CLI: `--path`) analyzes the exact selected file. Path resolution failures
  (`ENOENT`, `ENOTDIR`, `ELOOP`, `ENAMETOOLONG`) are `invalid_request` issues;
  permission failures keep their own classification. Intake is bounded to
  64 MiB. Big-endian ELFs, code sections that extend past the file, and
  code that ends inside an instruction are refused rather than decoded.
- `program_id` (CLI: `--program-id`) performs `getAccountInfo` at finalized commitment against
  `rpc_url`, `REA_SOLANA_RPC_URL`, or the public mainnet endpoint, in that
  order. BPF Loader Upgradeable programs resolve through their ProgramData
  account (tag 3 header: slot, optional upgrade authority, then the ELF);
  legacy BPF loader accounts holding an ELF directly are accepted as-is.
  The account must be executable and owned by a BPF loader, and ProgramData
  must be owned by the upgradeable loader; data accounts are refused. The
  JSON-RPC response is read with a byte cap before decoding. Evidence
  records only the endpoint origin (`rpc_endpoint`), never credentials,
  paths, or query strings from `rpc_url`. The
  fetched ELF is materialized as `<out_dir>/<program_id>.so` and analyzed as
  that local file, so both modes share one artifact identity semantics.
  `out_dir` is therefore required with `program_id`.
- When `out_dir` is selected in either mode, it must be absent or empty;
  the provider writes `solana-analysis.json` (the Evidence result) and
  `disassembly.txt` (the full linear-sweep disassembly) there through a
  digest-verified, exclusive output tree that is rolled back on failure, so
  it never overwrites the selected capture or earlier output.
- `instruction_names` (CLI: `--instruction-names`) supplies Anchor instruction
  names from an IDL or source; a handler candidate whose discriminator
  equals `sha256("global:<name>")[..8]` is confirmed with that name in its
  row. Unmatched candidates keep `name: null` — names are never guessed.
- `handoff: true` (CLI: `--handoff`, requires `out_dir`) additionally
  writes `<out_dir>/handoff/`: a byte-identical copy of the analyzed ELF at
  `handoff/elf/<file name>` (SHA-256 verified at write time), `handoff.json`
  (pinned identity, entrypoint, the full handler table, dispatch
  coverage, and the verified syscall surface), and `HANDOFF.md`, an
  analyst brief splitting known from candidate from unknown and naming
  the exact next step — feed the pinned ELF to REA's Ghidra/IDA native
  workflows, then differential-verify. The analyzer never invokes
  Ghidra/IDA itself. Batch mode writes the handoff into every item
  directory when selected.

## Evidence semantics

- Artifact SHA-256 covers the whole selected file, including any trailing
  account-capacity padding; `elf.trailing_bytes` reports how much of the file
  lies beyond the extents its ELF headers declare.
- ELF facts (class, byte order, machine, entrypoint, sections), dynamic
  symbols, and byte identity are observations. The record is nevertheless
  labeled `inferred`, because its headline output — the handler table — is
  inference.
- Handler candidates come from the dispatch idioms the analyzer can
  verify, each labeled by `method`:
  - `lddw-compare`: a 64-bit constant loaded by `lddw` and consumed, before
    any overwrite and within one straight-line block (the scan stops at
    `call`, `exit`, and `ja`), by a nearby register-register `jeq`/`jne`.
    That is the
    shape Anchor/rustc emits for instruction dispatch. The candidate
    records the discriminator (the constant's little-endian bytes), the
    constant and comparison addresses, and the handler entry: the branch
    target for `jeq`, the fallthrough for `jne`.
  - `split-compare`: the discriminator compared as two 32-bit halves —
    loads from `[base + 0]` and `[base + 4]` checked against immediates
    whose composed value is the discriminator, both guarding one handler
    (both bail to one skip target, or the low half bails and the high half
    branches in). Records both comparison addresses and the composed
    discriminator.
  - `table-dispatch`: a register-indirect transfer whose register was
    loaded from a read-only table of `.text` addresses at a constant
    base. Records the table address, the slot (`index:n` label), and the
    entry target; discriminator is null.
- The `dispatch` coverage block counts candidates by method and the
  register-indirect transfers that matched no verified idiom
  (`computed_jumps_unresolved`).
- Syscall surface is the ELF's undefined dynamic symbols (`sol_*` names)
  plus per-call-site resolution. A `call` immediate resolves only when it
  verifies: an `R_BPF_64_32` relocation naming the site (captured ELFs carry
  the `-1` placeholder at syscall sites; the relocation names the import),
  exactly one Murmur3-32 hash candidate across the canonical syscall
  registry and the ELF's own imports, or a pc-relative target landing
  exactly on a defined symbol. Each site records its resolution basis;
  unresolved sites keep the raw immediate.
- Disassembly is a linear sweep by the bundled sBPF decoder
  (`rea-sbpf-decoder`). It is not a Ghidra/IDA-grade lift: no control-flow
  recovery, Rust source, types, or account layouts are produced.
- `elf.e_flags` keeps the raw ELF flags and `elf.sbpf_version` the version
  they declare (0–4, or 2 for the legacy `0x20` flag). An unrecognized
  declaration reports `sbpf_version: null` and a limitation; decoding then
  uses version 0 rules, which select the `callx` register field.
- Distinct dynamic-symbol names are decoded once each, up to the fixed
  16 MiB `solana-elf-symbol-name-bytes` allowance; exceeding it is a named
  resource refusal, not a malformed-ELF verdict.

## Differential receipts

`solana_receipts` / `solana-receipts` closes the loop the analysis opens:
it joins an analysis with the recorded outcome of differential testing and
emits one receipt per handler candidate, so "recovered" is a claim with a
paper trail rather than a label. It never runs a differential itself.

```sh
rea solana-receipts --analysis-path ./pump_amm/solana-analysis.json --evidence-path ./evidence.json --json
rea solana-receipts --out-dir ./batch --evidence-path ./evidence.json --json
```

- Inputs: exactly one analysis source — `analysis_path`
  (`solana-analysis.json`) or `out_dir` holding a single run's
  `solana-analysis.json` or a batch run's `index.json` — plus
  `evidence_path`. Batch item locations derive from `out_dir` and each
  validated item name; paths stored in the index are never followed.
  Items whose batch analysis failed are reported in `skipped_items` with
  their recorded error.
- The evidence file holds one program document, or an array of documents
  for a batch:

  ```json
  {
    "program": { "elf_sha256": "<sha256 of the analyzed artifact>" },
    "handlers": [
      {
        "discriminator": "c9cff3724b6f2fbd",
        "name": "create_config",
        "verdict": "recovered",
        "fixtures": { "total": 6, "passed": 6 },
        "vm": "litesvm",
        "evidence_refs": ["repro/pump_amm/create-config/", "tx:2gNxbFQQ…"]
      }
    ]
  }
  ```

  Each entry identifies its handler by `discriminator` and/or `name`
  (a name resolves through `sha256("global:<name>")[..8]`), or a
  table-dispatch row by `table: { "address": n, "index": n }` (the row's
  `table_address` and `table_index`), and records a
  `verdict` (`recovered` | `failed` | `not-a-handler`), the `vm`
  (`litesvm`, `surfpool`, …), and `evidence_refs` (paths, transaction
  signatures, or URLs). `fixtures` carries the case counts as recorded;
  where the source kept counts only in aggregate program corpora, omit
  `fixtures` and state that basis in `fixtures_note` instead — counts are
  never synthesized. At most one document may name each artifact SHA-256.

- Outputs: a `receipts.json` beside each analysis (the per-program
  document: one receipt per candidate with its verdict, fixtures, VM, and
  refs, plus a summary), and at a batch root an aggregate `receipts.json`.
- Verdict rules (fail closed — this is the trust core):
  - Evidence attaches only to the artifact whose SHA-256 it names. In
    single mode a mismatch is an error and no receipts are emitted.
  - A receipt reads `recovered` only when its entry's fixtures are
    complete and all-pass (`total > 0`, `passed == total`), or when the
    entry carries a `fixtures_note` in place of exact counts. A recovered
    claim with failing, empty, or unexplained support is downgraded to
    `lead` and recorded in the summary's `issues`.
  - `failed` and `not-a-handler` carry the recorded outcome; every
    candidate without evidence stays a `lead`.
  - Entries matching no candidate are reported as `orphans` in the
    summary — never dropped, never attached to a different handler. Two
    entries claiming one handler, or an entry whose name and
    discriminator disagree, fail the build for that program.

## Limitations

- Dispatch idioms outside the three recovered shapes (and computed jumps
  whose tables cannot be verified) stay unresolved and are counted, not
  guessed; an empty handler list does not prove a program has no callable
  interface.
- A fetched program reflects the endpoint's finalized state at call time; it
  may differ from an earlier capture if the program was upgraded.
- Discriminator candidates are reconstruction leads. Behavior parity with a
  deployed program is established only by differential tests against the
  captured original (the pumpfun-source model), never by this scan alone.
