# NTFS metadata verification, 2026-11-11

Executed the packaged Linux CLI using Node 24.22.1, one CPU,
and a 1 GiB V8 heap cap against unmodified Windows 11 MFT records. This verifies
real acquisition bytes on Linux. This initial sample-only run did not exercise
a Windows runtime or paired journal stream. The later paired-volume fixture
verification below covers both logical streams without mounting a volume.

## Inputs and attribution

The records come from [omerbenamram/mft at
6b4988891e88a07e10e86caab4224b64bc96c94c](https://github.com/omerbenamram/mft/tree/6b4988891e88a07e10e86caab4224b64bc96c94c/testdata/win11).
Its [provenance notice](https://github.com/omerbenamram/mft/blob/6b4988891e88a07e10e86caab4224b64bc96c94c/testdata/win11/NOTICE.md)
identifies unmodified records from the Bart Windows 11 Pro image by Nuno
Mourinho, Mario Candeias and Rogerio Bravo, Instituto Politécnico de Beja,
[Zenodo record 10070982](https://doi.org/10.5281/zenodo.10070982), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The binary inputs
were downloaded only for local verification and are not committed to REA.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `system.MFT` | 34,816 | `c2cff41973b12243fe63900cdc2b02bbd0479350b44fc652437e1fcb17ead403` |
| `entry_45647_hard_links` | 1,024 | `8e673f39a5491131bc3654f58dac91c2e02605063fc284988efce8d2bf6a9869` |
| `entry_95063_usn_journal` | 1,024 | `16d563481f772390bca608842fb6a8a40eb96e54794effb480ccb939116fcaf2` |

## Executed checks and observations

Ran `rea inspect-artifact <selected-file> --json` separately for each input.
Parsed the returned Evidence and artifact metadata, then asserted:

- `system.MFT` has 26 FILE records in slots 0–15 and 24–33. All decoded slot
  identities agree with their declared record numbers. The eight zero slots
  are reported without renumbering later records.
- All three inputs have zero fixup mismatches, unverified fixups and incomplete
  local attribute walks.
- Record 45647 retains two `MMCEx.dll` names, namespaces 0 and 3, and distinct
  parent references `(1614, 1)` and `(18333, 1)`.
- Record 95063 retains a nonresident, sparse `$J` data stream (`flags: 32768`)
  and a resident `$Max` stream.
- A standalone extracted record declares its original record number while its
  supplied stream contains only slot zero. REA reports that disagreement and
  does not manufacture a matching acquisition identity.
- All selected input SHA-256 values remain unchanged after inspection.

The upstream notice supplies the Windows origin and intended fixture coverage;
these CLI observations were executed locally. No upstream parser was run as an
independent oracle for these three samples. V3/V4 journal decoding and error
recovery retain synthesized-fixture coverage. The later paired-volume run below
independently checks V2 records; authenticated forensic captures and Windows-host
execution remain unverified.

## Default journal delivery comparison

Compared `d31647d03` with `c37d26dca`: an analyst requests the journal events and
inventory counts without asking for MFT record details. Each completed workflow
first queries the CLI schema, then inspects 50 events. The MFT input is the
Windows system sample above; the 3,600-byte journal contains 50 synthesized V2
records. This is a controlled delivery comparison, not real paired-journal
verification.

Each CLI call ran in a fresh Node process, sequentially, on one CPU with a 1 GiB
heap cap and warm filesystem caches. One trial per variant includes startup,
acquisition, hashing and Evidence serialization. CPU covers the child process
family; RSS/PSS peaks are sampled every 20 ms and exclude the Python observer.

| Whole workflow | Before | Default summary after |
| --- | ---: | ---: |
| CLI calls | 2 | 2 |
| Proxy tokens, including command text, schema and result | 24,582 | 8,086 |
| Elapsed time, ms | 6,646 | 6,090 |
| Process-family CPU time, ms | 5,765 | 5,346 |
| Sampled peak family RSS, KiB | 251,740 | 246,428 |
| Sampled peak family PSS, KiB | 248,075 | 242,844 |

Proxy tokens use `tiktoken` 0.12.0 `o200k_base`; they are not measured agent
billing or reasoning tokens. Tool transport wrappers, model latency and warm
persistent-process runs were not measured. The single timing/memory samples do
not establish a stable speedup.

The schema query itself grows from 361 to 429 proxy tokens. All 50 event rows,
input identities and aggregate counts remain equal. MFT record delivery becomes
explicit: the default metadata representation is 424 serialized bytes rather
than the original 57,946 bytes. An additional validation call with
`--mftRecordLimit=32` reproduced the entire baseline normalized result exactly.
That full-detail workflow, including its schema query, uses 24,662 proxy tokens;
its CPU and memory were not measured separately.


## Integration with scoped acquisition reuse

The metadata increment now uses the shared resource-scoped pair introduced by
#9914. Its canonical MFT index retains headers, aggregate coverage and the
reference lookup. A requested detail page locates its first source slot in that
ordered index and decodes only the selected records from the validated retained
acquisition. It does not rescan all MFT attributes or rebuild the lookup. The
superseded full-attribute `MftImage` representation has no remaining consumers
and was removed.

The focused 100-test run covers MFT/attribute and V2/V3/V4 decoding, correlation,
reader/source identity, lifecycle failures and public CLI/MCP workflows. The
public MCP regression changes the MFT detail selection within the same session
and verifies two physical file acquisitions and one index parse in total, with
CLI/MCP result equality. Domain cases cover omitted sparse slots, independent
continuations, page ends and unchanged source bytes. This is correctness and
reuse verification; the earlier CLI measurements above remain observations at
their stated revisions, not new measurements of this integration.

Automated review also identified an obsolete format-descriptor limitation that
said names and attributes were not decoded. The owning `ntfs-mft` descriptor
now describes the delivered metadata and the remaining nonresident-payload,
extension-assembly and full-path limitations. The canonical inventory
regression verifies actual names/attributes alongside the limitation text;
reader coverage still reports corrupt fixups independently. No consumer-side
wording override was introduced.


## Paired-volume fixture verification

Executed the packaged REA CLI and production stdio MCP server at
`bae4ec0cdabc3401f84f61f49ee6867816fb0b6e` on Linux with Node 24.22.1.
The source is Fox-IT's Dissect Team
[`ntfs-cloud.bin.gz` volume fixture at
83f71a87e173613580eb31f64c600789f4259c20](https://github.com/fox-it/dissect.ntfs/blob/83f71a87e173613580eb31f64c600789f4259c20/tests/_data/ntfs-cloud.bin.gz).
The repository's [copyright notice](https://github.com/fox-it/dissect.ntfs/blob/83f71a87e173613580eb31f64c600789f4259c20/COPYRIGHT)
attributes Dissect to Fox-IT, part of NCC Group, and the Dissect Team, with AGPL3
terms. The compressed fixture and extracted binary streams remain local and are
not committed to REA. The fixture's original acquisition process and Windows
version were not independently authenticated; this is paired volume-fixture
verification, not a claim of verified production forensic provenance.

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| Published compressed volume | 1,234,746 | `c44f83257be7a8e0ff1aecb61fe82b362c44256808da216d8824ea735576af5a` |
| Extracted logical `$MFT` | 262,144 | `3a0f1a9c5bfa7d1d011eb1b391fddd40d5773a1cf89d7223165fd8516fb34d76` |
| Extracted logical `$UsnJrnl:$J` | 21,376 | `39bd88d262fc71e3d45b69bb559268191f76051a63f42415f60bc6357881b56a` |

### Independent extraction and oracle

Installed `dissect.ntfs==3.16`, `dissect.cstruct==4.7` and
`dissect.util==3.24` in an isolated temporary directory. Opened the compressed
volume through a seekable gzip stream, without mounting it or materializing its
1,054,866,944 decompressed bytes in memory. The independent NTFS parser read
both logical streams from that same volume: the unnamed data of MFT segment 0
and `$J` of segment 44 (`$Extend\$UsnJrnl`). Its 4,096-byte-cluster runs were
`(LCN 85845, 64 clusters)` and `(LCN 1418, 64 clusters)` respectively. Extraction
stopped at each declared logical length, excluding allocation slack.

Built an independent expected table from all 179 Dissect V2 records: source
positions and lengths, full file/parent references, USNs, raw FILETIMEs, reason
and source flags, security IDs, file attributes and names. Dissect independently
verified fixups for all 49 FILE records. Its local filename attributes supplied
all 45 names with namespace, parent, source offset, raw timestamps, sizes and
flags. Expected joins used the independently decoded slot and sequence identity;
a missing or mismatched identity remained unresolved.

### Executed public workflows and outcomes

The production stdio MCP client discovered the advertised tools and validated
replies with the SDK/Ajv2020 client contract. It traversed four journal pages
at 50 rows per request, then two independent MFT detail pages at 32 records per
request. Every event field and all filename facts above matched the independent
oracle. All four coverage rows described zero padding, checked directly against
the extracted journal bytes. Results retained:

- 49 FILE records, 48 in use, 13 directories, no extension records, and zero
  malformed/incomplete local attribute walks or unverified/mismatched fixups.
- 179 V2 events; 157 file references matched and 22 stayed unresolved. All 179
  parent references matched. The three old-name and six new-name reason rows
  remain separate source events; they do not establish complete rename pairs.
- The first result retrieved through `get_evidence_bundle` matched the original
  normalized page. Client and transport closed successfully.

The packaged CLI inspected the same pair with `--maxRows=200` and
`--mftRecordLimit=32`. Its 179 events, four padding rows and first 32 MFT details
matched the combined MCP results exactly. Continuations and omitted counts
matched the selected views. Both extracted input digests remained unchanged
after the CLI and MCP workflows. `historyCompleteness` remained `unknown`.

The extraction used one CPU, a 512 MiB address-space limit and a 30-second CPU
limit. REA/client processes used one CPU and a 1 GiB V8 heap limit each, with
90-second MCP and 60-second CLI timeouts. No resource guard stopped a task.
These were correctness checks; process-family memory and performance were not
measured for this fixture and no performance claim is made.

This run covers a paired V2 volume fixture on Linux. It does not establish
Windows-host behavior, authenticated forensic acquisition provenance, real
V3/V4 captures, extension-list assembly or nonresident payload recovery. Those
limits remain explicit alongside the existing synthesized boundary regressions.


## Acquired extension metadata verification

At `b76b9716192db1f2bbfdcbb093bb01c29a7e8d10`, the MFT owner additionally resolves
resident attribute-list graphs into acquired extension metadata. Physical facts
and their aggregate counts stay separate from bounded linked facts. Journal
and extension joins share the producer-owned record identity verdict.

The [source-built extension fixture](https://github.com/morluto/rea/blob/b76b9716192db1f2bbfdcbb093bb01c29a7e8d10/tests/fixtures/ntfsMftExtension.ts)
contains base slot 0 / sequence 2 and extension slot 1 / sequence 7. The base
list refers to the extension's FILE_NAME attribute ID 3; the extension declares
base reference `(0, 2)`. Dissect 3.16 independently verified both physical
records' fixups and decoded their `local` / `linked` filenames and source facts.
The byte-level fixture defines the expected ownership relationship. This is
synthesized extension coverage, not a real extension capture.

| Source-built input | Bytes | SHA-256 |
| --- | ---: | --- |
| MFT pair | 2,048 | `b512f7b270679dd5107b76c2787c6ca137b667bae1d3921ea1a0117fb94b5723` |
| V2 journal | 64 | `d4356fd78b1407d4e3fe1bf9ef4b55ef4552936334d5bc744db1531a31987b60` |

An 11-file focused run passed 121 tests. Nineteen new domain cases cover exact
identity and attribute selection, reused sequences, missing/wrong owners,
contradictory headers, failed fixups, ambiguity, cyclic/self-referential lists,
malformed list tails, valid target prefixes, unavailable nonresident lists,
named continuation mapping metadata and both reference/record budgets. Public
inventory and CLI/MCP tests verify linked facts and retain them as partial
Evidence when a later journal read fails. After consolidating the shared
identity verdict, all 24 extension/correlation tests passed again. The complete
MCP schema suite (16 tests) and format descriptor suite (4 tests) passed after
integrating main and regenerating the runtime catalog.

The packaged CLI and production stdio MCP server then inspected the
source-built pair at the revision above. The MCP client validated advertised
schemas, read one journal page and two separate one-record metadata pages, and
retrieved the first detailed result through `get_evidence_bundle`. The base's
linked filename matched the independent extension-record facts exactly, with
source value offset 1104 and attribute offset 1080. The local filename remained
separate. CLI event rows and selected metadata matched MCP; input digests were
unchanged and client/transport cleanup completed.

Re-ran the paired public-volume workflow from the previous section on the same
runtime revision. All 179 event fields, 49 physical records and 45 filename
attributes still matched the independent oracle. File/parent reference counts,
four padding rows, independent metadata paging, retained Evidence, CLI/MCP
agreement and unchanged input digests were preserved. These checks used the
same one-CPU / 1 GiB Node heap / bounded-timeout controls described above; no
guard stopped a task and no performance measurements are claimed.

Extension facts are qualified by page-local capacity and reference coverage.
Nonresident list values and volume file contents remain unavailable, and no
full path or complete history is inferred. Real extension captures and
Windows-host execution remain unverified.
