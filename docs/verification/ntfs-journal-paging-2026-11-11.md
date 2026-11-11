# NTFS journal page reuse, 2026-11-11

## Question and correction

An analyst traverses a supplied USN journal in one MCP session, checks exact
file/parent identities and coverage, retrieves retained Evidence, then closes
the session. Direct-offset decoding alone still repeated both complete file
reads/hashes, MFT interpretation and reference-map construction on every page.

The shared application workflow now retains one completed acquisition pair and
its interpreted MFT/reference lookup per `ArtifactResourceScope`. Exact selected
paths identify the candidate; their verified states bind the cached SHA-256
snapshots. Reuse checks device, inode, size, mode, and nanosecond modification and
change times using the regular-file boundary's comparison. Source changes or
unverifiable state refuse reuse and invalidate the entry; an explicit retry
performs a fresh acquisition. Parser/schema code is fixed for this process's
lifetime. Row limits and source offsets select views, not different parses.

Only successful reads whose descriptor finalization completed enter the cache.
Format refusals and failed/cancelled acquisitions are not cached. A completed
pair can survive a later caller cancellation. A changed selection evicts the
prior pair. There is one active inspection and one retained pair per scope;
concurrent admission returns a retryable capacity error. Scope shutdown joins
admitted work, retries owned cleanup and clears retained bytes. Acquired byte
buffers retain at most 128 MiB; parsed facts and lookup objects add memory bounded
by the admitted MFT. This is in-memory reuse, with no disk cache. A new CLI
process/scope starts cold; use the same MCP session for multi-page traversal.

## Executed verification

Compared baseline `c02bb7b1f` with `9f22dbbe9` using Node 24.22.1 and MCP SDK
2.3.1 over production stdio. The client discovered the catalog, selected tools
by name, validated replies against their advertised schemas, traversed every
journal row, fetched the first retained Evidence record by ID, and closed client
and transport. The fixture constructor used explicit NTFS field offsets and
expected 64-bit values, independent of the changed decoder. Assertions checked
every event's USN, timestamp, file reference, parent reference, matched indices,
name and raw reason/source flags, plus source digests and retained records.

| Case  | MFT                    | Journal                | Event pages | Total calls |
| ----- | ---------------------- | ---------------------- | ----------: | ----------: |
| Small | 1,024 bytes / 1 record | 192 bytes / 3 records  |           3 |           5 |
| Large | 8 MiB / 8,192 records  | 1 MiB / 16,384 records |          82 |          84 |

Calls include catalog discovery and retained-Evidence retrieval. Inputs are
synthesized acquisitions, not a real Windows capture. Large pages contain at
most 200 events; small pages contain one.

All sessions used one CPU and a 1 GiB V8 heap per Node process. A supervisor
sampled summed process-family RSS/PSS every 20 ms, with a 1.5 GiB RSS and
120-second guard. These measurements exclude kernel file cache and the Python
observer. Whole-family CPU/elapsed include client/server startup, discovery,
acquisition, hashing, decoding, SDK validation, transcript serialization,
oracle checks, retention retrieval and shutdown. Input generation and token
counting ran outside the timed family. OS file caches were warm; runtime disk
compile-cache state was not controlled. Every reported payload exited
successfully, cleanup completed, and no guard stopped a reported run.

Two alternating fresh sessions per implementation produced these large-case
ranges:

| Metric                       |          Before |           After |
| ---------------------------- | --------------: | --------------: |
| Whole-family elapsed, ms     |   15,279–20,460 |   11,623–12,662 |
| Whole-family CPU, ms         |   15,013–18,445 |   11,190–11,265 |
| First page, ms               |     2,929–4,128 |     3,854–4,208 |
| Remaining 81 pages, ms       |   10,412–13,831 |     5,826–5,942 |
| Sampled peak family RSS, KiB | 626,304–635,676 | 609,484–613,916 |
| Sampled peak family PSS, KiB | 573,485–582,762 | 556,728–561,123 |

Warm-page and whole-task costs improved in these completed large-input runs.
Cold-page benefit was not established. One small-case session per version took
5,996 → 5,090 ms elapsed and 4,970 → 4,877 ms CPU; its two warm pages took
18.5 → 16.6 ms. Its sampled RSS was 478,260 → 476,308 KiB and PSS
425,369 → 423,486 KiB. Setup dominates that case; no stable small-input speedup
or general peak-memory reduction is established by these observations.

Raw catalog, explicit request and reply serialization used exactly 5,963,287
`o200k_base` proxy tokens / 21,749,040 bytes per large run and 1,227,879 tokens /
4,621,886 bytes per small run (`tiktoken` 0.12.0). No token reduction is claimed.
This counts transport payloads, not rendered model context or actual model
usage; initialization/framing, prompts and reasoning tokens are unmeasured.

The initial small-case harness attempt unwrapped retained Evidence at the wrong
level and failed its assertion. The actual session-tool response uses `result`.
That harness was corrected before the reported fresh-session runs; the failed
attempt is not a product failure or a passing measurement.

## Identity and remaining limits

Large input SHA-256 values:

- MFT: `ab5671746e2b3b5a46860d87468b9e1d4f9af7df9179fe42ccb9a0fd31bfff7c`
- Journal: `8dd101b85a3186aef1dd1bcf4491713f4f2f060335b1bdde799daa38418c4023`

Small input SHA-256 values:

- MFT: `f2fe66fd2de50bc87067d47ceb716ce295a29cdcf58b4988b4503d9bf8ecbea6`
- Journal: `9d27ed73f04bc24c4070c07696a2950e1df49b87dc843e372189c4a41ac20ee8`

All six successful sessions had catalog digest
`0f606c384e77c5f9f4dbedb9fb2c84e807abc113b1e8facea7fc931f95428664`.
Normalized page-sequence digests matched across implementations:
`d4c6639b3955d52db070a45f37c9f26d4f021e4355cc6da1a511e1c8632e5dae`
(large) and `e31b9f771c7292dc04efee67e4025790d9af9db6e2623b977ecddd823813afe4`
(small). Digest comparison holds selected path values constant.

Regression checks also exercise same-size MFT writes with restored mtime,
same-content journal replacement, validation permission/I/O failures, pair
eviction, closed admission, a cancelled peer, active close joining, cancellation
during final journal cleanup, and failed-close retry without caching that failed
attempt. Public MCP tests confirm warm reads reuse both physical acquisitions
and the MFT parse. Freshness verification uses filesystem metadata; Windows-host
execution, maximum-size inputs and real paired journal captures remain
unverified. The supplied bytes still cannot establish complete journal history.
