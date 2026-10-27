# Directory decompilation: capacity, resume and source Evidence

The directory-export feature requested in #6090 already shipped in #6170.
This follow-up verifies the current public workflow and fixes a source-provenance
gap found while combining it with existing Ghidra projects (#1048).

## Completed task and correctness

The analyst asks for all functions as local pseudocode files, without putting
their bodies in agent context. The committed `decompile-directory.mjs` driver
uses the production stdio MCP entrypoint and installed SDK. It discovers the
catalog, exports an initial chunk, closes/reopens the provider, resumes all
remaining work, and resumes again to verify settled files. It authenticates an
explicitly exported Evidence bundle and checks the original target/project.

Every written file is checked against its index SHA-256 and address/profile
header. Existing file hashes and modification times must survive both resumes.
Comparison facts include every address, name, status, body range and pseudocode
digest. An independent fresh-import investigation from #1048 additionally checks
the complete inventory and two nonempty pseudocode observations. This establishes
export preservation of provider observations; it does not establish discovery of
every actual function or equivalence to original source.

| Real artifact           | Provider inventory | Written | External | Failed |
| ----------------------- | -----------------: | ------: | -------: | -----: |
| `/usr/bin/ls`           |                652 |     541 |      111 |      0 |
| system `libcrypto.so.3` |             14,338 |  14,194 |      143 |      1 |

Target SHA-256 values are respectively
`cb30d69b24245bf2ecdc9e7f53bbad19159999970b6d82c0c00c7d32d9e37aa4` and
`aa01e614af634bc7c8b678c9250b5c4f613c61989bacf0a5d6aed6570e7dcabd`.
These installed ELF x86-64 binaries were analyzed statically, never executed.
The large run explicitly selected a five-second per-function deadline; function
`0x387f00` exceeded it, remained a recorded failure, and was retried on resume.
Later functions were still exported. No disappearance of that failure is claimed.
The resulting large tree occupies about 107 MiB on this filesystem.

## Source-provenance correction

Before this change, `BinarySession` retained provider `sourceEvidence` only inside
its snapshot-eligible branch. Ghidra procedure reads without a document selector
are not snapshot eligible. A composed directory export therefore lost saved
project reports even though the provider supplied them. The workflow also ignored
source-record IDs, and the function-dossier adapter copied observation fields
manually without those links.

The session now authenticates/retains source records independently of replay
eligibility. Plain application helpers also return authenticated immutable source
records with their outcome, including late cancellation. Both adapters explicitly
commit them before delivering links; an adapter without a retention owner refuses
the response. Source collection borrows ledger records without constructing or
hashing an intermediate bundle. The workflow links distinct source IDs without copying their payloads.
The function adapter uses the common observation-to-Evidence constructor,
preserving sources through normal and late-cancelled completion. Queries with no
source records avoid the extra recording path. Complete provider bodies remain
in the exported function files; this does not add per-function payload retention.

A real test project contains historical seed and disabled-analyzer reports saved
by REA's actual Ghidra pre-scripts. The unmodified runtime completed the export
but failed the provenance oracle: its bundle had two workflow records and no
historical source. The fixed runtime retains exactly one historical source and
links the workflow to it. All 652 inventory entries and the sampled pseudocode
still match fresh import; source project content stays unchanged. The report is
historical, with remaining original settings/completeness explicitly unknown.

## Measured costs

Baseline runtime: `19447516a4bdbc9437d112ebd3f12a5fd062db83`.
Initial fixed runtime: `f50763fd21527bdf3bab944633617b9df61dded4`, rebased on
main `f02df45a4`. Both use Node 24.22.1, locked dependencies, actual Ghidra 12.1.4
and JDK 21.0.12.1+1. The fixed driver later delegates transcript publication to
the existing cleanup/receipt owner; the protocol and task are unchanged.

| Completed task                    |  Wall s | Family CPU s | Peak family GiB | Full-wire token estimate |
| --------------------------------- | ------: | -----------: | --------------: | -----------------------: |
| ls, before                        |  51.411 |       78.984 |           0.943 |                   57,082 |
| ls, initial fix                   |  50.937 |       79.891 |           1.201 |                   57,072 |
| ls with historical reports, fixed |  52.827 |       80.236 |           1.097 |                   57,207 |
| libcrypto, baseline capacity run  | 506.387 |      459.818 |           1.502 |                   57,322 |

The plain ls pair has identical complete comparison facts. Runtime is similar;
the higher sampled memory in the fixed run is reported rather than treated as an
improvement. These sequential shared-host samples establish no generic speed or
memory ratio. [PR #7250](https://github.com/morluto/rea/pull/7250) records the final
large-run comparison and CI/review results.
The failed historical baseline is excluded from completed-task comparisons.

The complete MCP replies stayed around 11–12 KiB, including repeated textual and
structured representations, profile and caveats. The normalized result is only
the manifest. For example, the large continuation costs about 3,159 estimated
wire tokens; its complete task is 57,322 because discovery alone costs 47,049.
Both numbers include actual protocol content, rather than only pseudocode bytes.

Estimates use `cl100k_base` on the actual JSON-RPC messages, including discovery,
requests, responses and notifications, excluding only transport framing and the
driver's local transcript wrapper. They are not actual model billing. Host
projection, prompts/reasoning and later agent file reads remain unmeasured.
The historical source increases response token cost slightly while preserving
provenance. No token-reduction claim is made for this correctness fix.

CPU and memory cover the driver, REA and provider process family. Each run uses
CPU affinity 0,1 and an 8-GiB sampled family-RSS guard; Java heaps are 1536M for ls
and 3072M for crypto. RSS is sampled every 100 ms and summed: shared pages may be
counted repeatedly and short peaks may be missed. CPU is waited child usage.
Reported completed runs had no resource stop, OOM or cleanup failure.
Project preparation is excluded and documented separately in
[project reuse](ghidra-project-reuse.md). Provider starts are process-cold, with
host filesystem caches unflushed; verified resume occurs in the second session.

The index and inventory still scale with function count. This 14,338-item run
does not establish a larger capacity guarantee. Real Windows/macOS filesystems,
other decompilers and native DWARF directory layout remain unverified. The current
workflow reports unavailable DWARF layout explicitly instead of inventing it.

Actual CLI `decompile-all` calls additionally selected only `0x10a420`, reported
651 excluded entries and `debug_layout_unavailable` for requested dwarf layout,
then resumed in a new process. The existing file's hash and modification time
stayed unchanged; the returned historical source ID stayed stable. This CLI check
verifies the returned manifest/link and local function file, not offline retrieval
of the separately retained source record after the CLI process exits.

## Reproduce and inspect

Prepare an owned project using the documented
[existing-project route](../../docs/installation.md#reuse-an-existing-ghidra-project).
Use fresh receipt/output paths; the driver refuses existing output directories.

```sh
node experiments/analysis-efficiency/decompile-directory.mjs \
  --runtime /absolute/rea --output /absolute/new-receipt \
  --target /usr/bin/ls --project /absolute/ls-analysis.gpr --program ls \
  --ghidra "$GHIDRA_INSTALL_DIR" --java "$JAVA_HOME"
```

Use `--chunk 512 --heap 3072M --decompile-seconds 5` for the crypto case.
`--control /absolute/previous-receipt` compares all exported facts;
`--golden /absolute/fresh-import-receipt` checks the #1048 driver's inventory and
pseudocode oracle. `--history required` additionally requires a linked historical
source. The driver allows failed functions to succeed on a later retry, verifies only
previously written files remain unchanged, and reloads the final index before
comparison. Complete local receipts include the transcript, resource report, index,
function files, comparison facts and authenticated Evidence export. The resource
report is supplied by the external process-family sampler, not the driver.

The current nine-file suite passed 144 tests. Against unmodified main source,
the three source-retention/constructor suites reproduce seven failures and 70
passes; the fixed full suite passes. This includes invalid source commitments,
live and cursor-dependent reads, shared source deduplication, selected/null/provider
subjects, and source links on late-cancelled completion.
