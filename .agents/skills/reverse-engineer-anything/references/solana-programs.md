# Solana programs

Use REA's `analyze_solana_program` when the ground truth is a deployed Solana
program: its source is unavailable, untrusted, or suspected to differ from
the deployed ELF. Do not use it for ordinary source-repository analysis.

## Workflow

1. **Capture.** Prefer an existing local capture when byte identity with a
   known on-chain state matters. Otherwise fetch by program id:
   `rea analyze-solana-program --program-id <id> --out-dir <dir>` (or the MCP tool
   with `program_id` + `out_dir`). Intake is read-only `getAccountInfo` at
   finalized commitment through the BPF Loader Upgradeable ProgramData
   layout; the fetched ELF lands at `<out_dir>/<program_id>.so` (the output
   directory must be absent or empty). Record the
   returned artifact SHA-256 and slot — they name exactly what you analyzed.
2. **Analyze.** Run the analyzer on the ELF (`--path <path>`, optionally
   `--out-dir <dir>`, absent or empty, for `solana-analysis.json` and the full `disassembly.txt`).
   Read the Evidence: ELF sections/entrypoint, disassembly counts, undefined
   dynamic symbols (the `sol_*` syscall surface), bounded `.rodata` strings,
   and the handler candidate table.
3. **Map discriminators to candidate handlers.** Each handler row is an
   Anchor-style lead recovered from the `lddw` constant + register-compare
   dispatch idiom: discriminator bytes, constant/comparison addresses, and
   the handler entry (branch target for `jeq`, fallthrough for `jne`). When an Anchor IDL or
   source names are available, confirm a lead by checking
   `sha256("global:<instruction_name>")[..8]` against the discriminator
   (account discriminators use the `account:` prefix). Leads that match no
   name stay labeled candidates — never rename them by guesswork.
4. **Hand off to differential verification.** Decompilation output is a
   reconstruction lead, never proof. For deeper decompilation, produce the
   handoff artifact first (`--handoff`, or `handoff: true`; add
   `--instruction-names` with the IDL instruction names so confirmed handlers
   are named): the analyzer writes `<out_dir>/handoff/` containing the
   pinned ELF copy at `handoff/elf/` (byte-identical; verify its SHA-256 against
   `handoff.json` before use), `handoff.json` (pinned identity, the full
   handler table, dispatch coverage, and the verified syscall surface),
   and `HANDOFF.md` — an analyst brief splitting known (observed/verified)
   from candidates (IDL-confirmed vs unnamed leads) from unknown. Feed
   that pinned ELF to REA's Ghidra/IDA native workflows; the analyzer
   never invokes them itself. Following the pumpfun-source model: rebuild
   or write the candidate implementation, then run it side-by-side with
   the captured original in a local VM (LiteSVM/Surfpool) over fixtures
   derived from real transactions, and compare resulting account bytes,
   return data, and errors. A handler counts as recovered only when its
   differential receipts pass; the discriminator scan alone does not
   establish behavior, account layouts, or arithmetic.
5. **Record the receipts.** Turn the differential outcome into a paper
   trail with `rea solana-receipts` (MCP `solana_receipts`): point it at
   the analysis (`--analysis-path <solana-analysis.json>` or `--out-dir <dir>` —
   a batch out_dir works too) and an evidence JSON naming, per handler,
   the verdict (`recovered` / `failed` / `not-a-handler`), the VM, the
   evidence refs, and the fixture counts as recorded — or a
   `fixtures_note` stating the as-recorded basis where counts live only
   in aggregate corpora. The builder binds evidence to the artifact by
   SHA-256 and refuses a mismatch. Read the returned `receipts.json`:
   a candidate reads `recovered` only on complete all-pass counts or an
   explicit as-recorded note, unsupported recovered claims are downgraded
   to `lead` and flagged in the summary issues, unmatched evidence is
   reported as orphans, and everything untested stays a `lead`. Those
   verdicts — not the scan, not the differential run alone — are what a
   "recovered" claim may cite.

## Boundaries

- The analyzer never executes the target, builds transactions, or touches a
  wallet. RPC intake is the only network step and is read-only.
- Split 32-bit compares and read-only jump tables are recovered as
  labeled candidates (`split-compare` / `table-dispatch`), with the
  dispatch coverage block counting each method. Computed jumps matching
  no verified idiom are counted as unresolved, never guessed; an empty
  handler table is an unknown, not a negative result.
- `call` immediates are resolved only when they verify: an ELF relocation
  naming the site, exactly one Murmur3-32 hash candidate (the hash the
  loader substitutes for a syscall name), or an exact defined-symbol
  target. Everything else stays an unresolved immediate — never a guessed
  name. Each resolved site records its basis in the Evidence.
- Full sBPF-to-Rust lifting is out of scope. For deeper decompilation, feed
  the captured ELF (identity pinned by the Evidence SHA-256) to Ghidra/IDA
  through REA's native workflows and treat their output with the same
  lead-then-verify discipline.
