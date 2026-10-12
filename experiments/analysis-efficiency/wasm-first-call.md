# WASM first-call summary delivery

Refs [#2016](https://github.com/morluto/rea/issues/2016). This bounded follow-up
adds optional MCP `inspect_wasm_artifact detail: summary`. Omitted/complete MCP
requests and CLI output remain complete. Full original Evidence is retained;
delivery selection is stripped before provider inputs, and exact export views
read the original parent without another WABT invocation.

## Pinned repeated public SDK cohort

- Control: `18e5d6275965c5f1d3ef9fe373d1792822098003`.
- Candidate: `45831c622a13368494d2a8f3a9718effa91c937c`.
- Runtime file-table SHA-256: control `ef65527c2d41b621f71059b7553050660d801ad905a61a71b81aba266f70e1ec`;
  candidate `353f5513ea09b0a627fa99814cebe0a1231c6c8f7e0e12a28205521133478b1a`.
- Actual WABT 1.0.42, identical explicitly selected provider configuration and
  effective search-path fingerprint, pinned Node 24.18.0 and locked SDK.
- Three paired fresh-process trials per digest-pinned shipped module, serial
  on one CPU: control/candidate, candidate/control, control/candidate.
- Same validation/counts/first-four complete export forms/WAT identity/provider
  identity/execution and fetch states; complete original source Evidence ID is
  also compared. All nine pairs preserve these selected facts and source IDs.

| Shipped module                | Result JSON bytes, control → summary | Calls / errors | Median seconds, control → summary (ranges)      |
| ----------------------------- | -----------------------------------: | -------------- | ----------------------------------------------- |
| `sqlite.wasm`                 |                      20,118 → 18,533 | 3/1 → 2/0      | 15.962 (15.719–21.138) → 18.171 (10.242–18.649) |
| `vscode.tree-sitter-css.wasm` |                      20,366 → 18,781 | 3/1 → 2/0      | 4.920 (4.885–4.936) → 5.191 (4.971–5.232)       |
| `vscode.tree-sitter.wasm`     |                   6,433,872 → 18,891 | 1/0 → 2/0      | 5.225 (5.172–5.519) → 4.763 (4.729–4.830)       |

Byte counts include all investigation call results, including failed delivery
and extra views. They exclude catalog responses, raw wire framing and file
exports; they are not actual model tokens. The complete catalog is 2,359,082
versus 2,362,451 JSON bytes (+3,369 bytes, about 0.14%). An extra export-view
call is included when summary replaces an otherwise fitting complete reply.

| Shipped module                | Median owned CPU seconds, control → summary | Median sampled family MiB, control → summary (maxima) |
| ----------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| `sqlite.wasm`                 | 15.376 → 15.954                             | 660.84 (671.27) → 633.07 (671.51)                     |
| `vscode.tree-sitter-css.wasm` | 5.760 → 6.027                               | 692.91 (694.93) → 678.98 (693.88)                     |
| `vscode.tree-sitter.wasm`     | 6.134 → 5.663                               | 674.04 (695.66) → 550.66 (553.47)                     |

All 18 scopes have no sampled abort and their last observations contain no
memory-high/hard/OOM/OOM-kill or task-limit event. Final counters are unverified
under the subsequent closeout audit below. Sampling can miss brief peaks. Application caches are cold per process;
host page caches are not flushed. SDK elapsed time includes startup, discovery,
schema work and persistence, not just provider analysis. Three observations
give descriptive medians/ranges, not a statistical or cross-domain speed claim.

SQLite and the CSS grammar already recovered an oversized complete result
through retained views in the control. The new path removes the initial error
and one call; result-byte savings are correspondingly modest. The Tree-sitter
runtime fits the MCP frame but delivers megabytes of unneeded WAT; its summary
plus exact exports greatly reduces delivery. Full provider analysis and complete
Evidence retention still occur, so this does not establish an engine shortcut.

An earlier 18-run cohort did not activate the treatment: the driver looked
for an inline enum and missed SDK-generated `$ref` definitions. Those original
runs and their source are archived separately and excluded from benefit claims.
The corrected driver validates the actual advertised 2020-12 request schema.

## Real model verification

Ten actual Codex CLI 0.161.0 trials request `gpt-5.6-terra` high: three paired
SQLite repetitions and one pair for each published VS Code component. The
resolved server-side model identity is not inferred from the requested alias.
Same question, fixed developer instructions, four allowlisted REA tools and
explicit WABT settings; private profiles, shell/web/other-agent restrictions
and target-byte preservation remain verified.

All ten answers match the 12 requested producer facts, including exact export
forms and explicit execution/fetch states. Reported Evidence IDs occur in real
responses; all copied profiles are removed. Manual review retains static-analysis
limitations and makes no original-source/runtime claim. Every candidate chooses
`detail: summary` on its first inspection and then reads exports without WABT
rerun. Original control errors and client-context clipping remain in transcripts.

| Module / observations per side    | Total input, control → summary |      Cached input |  Uncached input |        Output |
| --------------------------------- | -----------------------------: | ----------------: | --------------: | ------------: |
| `sqlite.wasm` / 3                 |                96,832 → 79,264 |   70,656 → 51,456 | 26,215 → 28,004 | 1,470 → 1,512 |
| `vscode.tree-sitter-css.wasm` / 1 |               247,889 → 79,389 |  207,872 → 61,440 | 40,017 → 17,949 | 1,931 → 1,327 |
| `vscode.tree-sitter.wasm` / 1     |              556,424 → 282,165 | 478,208 → 239,360 | 78,216 → 42,805 | 2,560 → 2,110 |

SQLite rows show medians of three observations; VS Code rows are single pairs.
Usage is the CLI-reported total for the turn, with cached/uncached input listed
separately. Lower total input does not imply a proportional monetary saving,
uncached-input reduction or faster answer.

| Module                        | Calls / observed errors, control → summary | Seconds, control → summary                      |
| ----------------------------- | ------------------------------------------ | ----------------------------------------------- |
| `sqlite.wasm`                 | 3/1 → 2/0                                  | 61.521 (54.301–80.579) → 55.656 (42.960–62.145) |
| `vscode.tree-sitter-css.wasm` | 3/1 → 2/0                                  | 87.126 → 106.580                                |
| `vscode.tree-sitter.wasm`     | 4/0 → 2/0                                  | 56.952 → 104.999                                |

SQLite total input falls about 18% and median answer time about 10%, while
its median uncached input rises about 7%. The two VS Code pairs reduce total
input by about 49% and 68%, but observed answer time rises about 84% and 22%.
These data support optional smaller delivery; they do not establish uniform
model speedup. The runtime control also makes one protocol resource-discovery
call, included in the four-call count. Cache state, model reasoning and service
latency are not separated by this small sample.

The model and SDK cohorts ran with the original resource wrapper. Their final
receipts retain last-sampled cgroup counters, not verified final counters.
The subsequent closeout correction regrades all ten existing answers: selected
facts, real IDs, unchanged target bytes and profile cleanup still pass, while
the final resource conditions are **unverified**. No model/build/provider run
was repeated for that review-only correction. Last-sampled peaks are 656–944
MiB for model scopes with no observed limit events; one CPU, 4 GiB hard ceiling,
3 GiB early-stop and no-swap controls were active. This is not a proof of absent
late resource events or a fully resource-qualified performance conclusion.
The original transcripts/usage and regrades remain archived separately.

## Reproduction and verification

Use [the common measurement/model instructions](README.md) with the public
digest-pinned inputs in [corpus.json](corpus.json), `--schemas selected` and
`--delivery summary`. For each artifact run the above three paired orders
against separately frozen runtimes, then `compare.mjs`. Use the same
[WASM interface question](questions/wasm-interface.txt), four exact enabled
tools (`inspect_wasm_artifact`, `inspect_analysis_view`, `get_evidence_bundle`,
`export_evidence_bundle`), explicit WABT settings and resource scope for models.

The VS Code artifacts are two published components from
[@vscode/tree-sitter-wasm 0.3.1](https://github.com/microsoft/vscode-tree-sitter-wasm).
The selected regular archive members have verified digests and package SHA-512
integrity. This is component analysis, not proof of the whole VS Code runtime.

The prototype passes 54 focused assertions and full static/docs gates. After
rebasing, 29 focused assertions and 42 actual installed-package WABT CLI/MCP
cases pass; the final rebased snapshot passes build/fast static and seven WASM
MCP workflows again. Omitted/explicit-complete behavior, retained identity,
fixed-server absence of retention, oversized continuation and invalid WAT
digest remain checked. No version publication or target execution occurs.
The final static/build scope has 51 soft memory-high events and no hard/OOM
events; this is not credited as a performance trial.

Detailed JSON, transcripts, target bytes, profiles and acquisition receipts
stay outside Git. Source inputs, scripts and this concise measured scope are
reviewable in the repository.

## Main integration checkpoint

Prerequisite #2122 is merged at `58fb372071e56da9c5df0e37593ee3f0da6b64bc`.
The follow-up is rebased directly onto latest fetched main. Intervening changes
outside the prerequisite concern CLI/logging/CI planning rather than WASM
production/delivery. Seven focused WASM MCP workflows and one fresh real-WABT
SQLite public-SDK request pass against the new build: selected facts and original
source ID match the pinned candidate, summary uses two calls with no tool error.
Only the relevant integration checks and required pre-push gate are repeated;
earlier measurements retain their original runtimes, not the new main label.
