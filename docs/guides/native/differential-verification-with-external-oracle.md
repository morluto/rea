# Differential verification with an external oracle

An analysis Evidence packet is a derivation, not a ground truth. When a claim
matters — a reconstruction reproduces a stripped binary's behavior, or two
models of the same code agree — the strongest available falsifier is an
**external, pre-sealed differential oracle**: a corpus that was produced against
the real binary *before* the claim was made, compared at byte level with zero
tolerance. This guide shows how to apply that pattern to a native binary after
using REA's analysis workflow, using a public, MIT-licensed worked example.

It does **not** certify any analysis, prove correctness of any tool, or replace
REA's own verification discipline. The example targets GNU coreutils 9.10 on
Linux x64 and is self-contained: you only need `gcc`, `sha256sum` and the
oracle files from this package.

## The example artifacts

Public package `rxre-cleanroom` (MIT, commit `fe3c6f7`):
https://github.com/LexLuthorPrimero/rxre-cleanroom

It contains two sealed reconstructions of functions inside real stripped
binaries, verified against the native binaries used only as read-only runtime
oracles:

- `filenvercmp` — the version-aware filename comparator inside `/usr/bin/ls`
  (GNU coreutils 9.10): `filenvercmp` @ vaddr `0x4fa0`, `verrevcmp` @ `0x4b60`,
  `file_prefixlen` @ `0x4a80`. Target: `/usr/bin/ls`, sha256
  `54e936d37decdad9ecaf189b1de347605a0a99037ec87bd17679b6cbde871a0c`,
  ELF64 PIE stripped, 153,400 B. Sealed corpora of 34,145 (seed 20261112) and
  34,145 (seed 20261113) unique input pairs; zero divergences in both, over two
  independent toolchain families, after discriminating tests eliminated 791
  divergences in an earlier empirical model (25,468 → 1,014 → 791 → 0).
- `wc` — a semantic reconstruction of `/usr/bin/wc` (`/usr/bin/wc`, sha256
  `81d614595c717be908fce809713702efd35ce5a56f5ab7cbc497d1a61eb1a38f`,
  61,448 B stripped dynamic). Verified in both `LC_ALL=C` and an UTF-8 locale
  over the corpus shipped there: 4,899 + 4,914 (default), 11,872 (flag
  combinations), 13,072 (`-L` + flag sets), 2 × 1,184 (high bytes / NBSP),
  2 × 1,184 (UTF-8 multibyte) — zero divergences in every run.

The corpus and matrices are synthetic; no GNU code is redistributed. The
native binary is used read-only at oracle time.

## Step 1 — Seal the target and open it with REA

Hash the target before any analysis and pin the observation:

```sh
/usr/bin/wc     # sha256 81d614595c717be908fce809713702efd35ce5a56f5ab7cbc497d1a61eb1a38f
sha256sum /usr/bin/wc /usr/bin/ls
```

Then obtain REA's composed overview (Linux x64, Ghidra 12.1.4), observed
2026-11-13 on the hashes above:

```sh
rea analyze /usr/bin/wc --format json
rea analyze /usr/bin/ls --format json
```

Observed output (your counts may differ by Ghidra version; they are evidence,
not a contract):

| Target | Evidence | procedure_count | string_count | segments |
|---|---|---|---|---|
| `/usr/bin/wc` (`81d61459…`) | `ev_31489fcb17927efbd6c2be6f2657206bd838e4283293962d589ec442d9d92e5b` | 265 | 219 | 34 |
| `/usr/bin/ls` (`54e936d3…`) | `ev_549e4736d70dbc2429d1dbe0a5a105c822516be30d696e5020cf9471ab2d0e31` | 529 | 525 | 34 |

Both Evidence packets report provider `rea-workflow` with an underlying
`ghidra 12.1.4` profile (import mode `ephemeral-source-immutable`), image base
`0x100000`, and are marked `confidence: derived`, `authority: shipped-artifact`.
Read the packet's `limitations` list before relying on any field: the overview
establishes counts of defined strings and identified functions — not absence
of undefined strings, not identification of the interesting function, not
semantic equivalence of anything.

Neither run identifies which procedure is `filenvercmp` — the binary is
stripped, and REA does not invent symbol names. REA's Evidence tells you what
Ghidra's default analyzer recovered; it is a starting inventory, not a verdict.

## Step 2 — Reproduce the external oracle

Do not trust the report; refute it where it is cheap to refute:

```sh
git clone https://github.com/LexLuthorPrimero/rxre-cleanroom
cd rxre-cleanroom
sha256sum -c SHA256SUMS          # whole package integrity
gcc -std=c11 -O2 -o verify_wc wc/src/wc_count.c wc/harness/verify_wc.c
./verify_wc wc/corpus/cases_seed20261114.txt wc/corpus/matrix_native_wc.txt C
#   total=4899 mismatches=0
```

The `wc` tree ships its full sealed corpora; the root `filenvercmp` tree ships
a 1,000-case sample plus the harness (`gcc -o verify_recon harness/verify_recon.c src/filenvercmp.c`).
See `INDEX.md` and `wc/INDEX.md` for every corpus/mode invocation and the
seal-before-reveal protocol. A blind-verification issue (#1) is open for
independent confirmation; as of 2026-11-13 it has no third-party reports.

## Step 3 — Use the oracle to challenge claims downstream of analysis

The reusable pattern, whatever the claim:

1. **Pin** the target by SHA-256 (analyst input).
2. **Derive** candidate behavior from analysis Evidence (hypothesis).
3. **Seal** the corpus and oracle before judging the hypothesis (seal first,
   reveal second — no adaptive fitting after the fact).
4. **Score** with zero tolerance: any divergence refutes the hypothesis until
   fixed. (In the worked example, the discriminating tests eliminated real
   divergences; the method found what a byte-audit and 256/256 byte-class probe
   could not, and vice versa — use both.)
5. **Report** the verdict with the seeds/hashes/tool versions. An
   `INSUFFICIENT` or `NOT_DETERMINED` outcome is a valid result; do not convert
   absence of divergence into a production claim.

## What is established, and what is not

- Established by direct observation on the author's host: the REA runs above.
- Established by this public package (MIT): differential agreement between the
  reconstructed C code and the native binaries over the sealed corpora, in the
  stated locales — with the limits stated there (no CJK wide-char modeling;
  `-m` ≡ `-c` observed only in `LC_ALL=C`; no third-party verification yet).
- Not established: that REA produced these numbers inside the Evidence as
  ground truth; that either reconstruction is production-fit; that the method
  generalizes to arbitrary binaries; that anything in this package validates
  or is endorsed by the REA project.
- Not claimed: "REA verified", "PASS", or any warranty of correctness for
  downstream use of either binary or reconstruction.

## References

- Package: https://github.com/LexLuthorPrimero/rxre-cleanroom @ `fe3c6f7` (MIT)
- Blind verification call: https://github.com/LexLuthorPrimero/rxre-cleanroom/issues/1
- Local REA profile observed for this guide: Linux x64, Ghidra 12.1.4 via
  `rea analyze` (2026-11-13), shipped Evidence `ev_31489fcb…` and `ev_549e4736…`
- This guide's companion proposal: LexLuthorPrimero's RXRE work
  (differential method, seal-before-reveal)
