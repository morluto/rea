# NTFS metadata verification, 2026-11-11

Executed the packaged Linux CLI using Node 24.22.1, one CPU,
and a 1 GiB V8 heap cap against unmodified Windows 11 MFT records. This verifies
real acquisition bytes on Linux; no Windows runtime, live volume or real paired
journal stream was exercised.

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
independent oracle. V2/V3/V4 journal decoding, paging and error recovery retain
synthesized-fixture CLI/MCP coverage; real paired MFT/journal captures and
Windows-host execution remain unverified.

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
