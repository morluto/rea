# Latest-main efficiency continuation

Continues [#2016](https://github.com/morluto/rea/issues/2016). The 2026-10-13
fetch resolved main to `f254f5ac2b804b353a711264bb178f43fdf07867`, the same
revision as the preceding Android conclusion. Newer capabilities below were
added during that earlier cycle; they are additional measurement scopes, not
new commits after that conclusion.

| Capability                    | Existing controls                                                                        | Next evidence needed                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Flutter / Dart AOT (#1582)    | Explicit ABI, bounded string observations, partial coverage                              | Real shipped snapshot/count question; opt-in delivery only if unrelated strings dominate    |
| SQLite (#2271)                | Compact inventory, selected table/columns, row limit                                     | Real application database and model workflow before adding another selector                 |
| TShark (#2318)                | Fields, filter, decode-as, pass, default 50 matching rows, paging, explicit null for all | Real public capture and repeated task cost; paging repeats dissection                       |
| sigrok (#2339)                | Decoder/channels/annotation selection, default 50 display lines, paging                  | Real public capture; display-line count is not annotation count and paging repeats decoding |
| Retained unknown head results | Existing retained paging                                                                 | Reuse the existing view rather than duplicate its implementation                            |

Attached IDA, Frida and other live runtime workflows involve separate authority
and lifecycle questions and are outside this static parsing continuation.
Plugin SDKs and cross-session engine caches remain deferred until an observed
need and benefit justify them.

## First selected scope: Dart AOT

The official LocalSend 1.18.2 arm64 APK is pinned in `corpus.json`. The initial
real public SDK baseline inspected actual bytes without executing/installing
the APK. Its complete default AOT reply was 151,341 compact client-result JSON
bytes (70,487 normalized bytes), with 500 package URIs, 216 Dart URIs and 2,000
class-like tokens. String-pool and overall coverage were partial. A second
explicit arm64 request returned the same normalized facts.

These are exploratory first/warm calls, not an optimization pair. The frozen
runtime source is `28c84e78cf2fbfde4aceed345b773c59eb889f68`, with production
source bytes verified equal to main f254 at baseline acquisition. Its compiled
file-table digest is
`5332dda13981f043e146b3601ebec1f380d9f698280ca53d75786b638a912e11`;
the receipt is not relabeled as a newer build.

The candidate adds explicit MCP `detail: "summary"` and retained pool pages.
Omitted/complete requests and the CLI preserve the old complete path. Analysis,
ABI selection and original Evidence stay intact. Summary retains target/libapp
identity, exact nullable snapshot observations, lower bounds, returned counts,
coverage and limitations. Pages preserve original string order and source
coverage without rescanning. No engine cache, provider protocol or third-party
plugin API is introduced.

Follow-up measurements must compare identical selected facts, portable old
Evidence and actual model tasks. Reply bytes do not establish token or latency
improvements. Whole-scope final counters remain unknown if their cgroup has
disappeared, even when the narrower payload-exit observation is verified.
Raw records, binaries and model traces stay in the private lab outside Git.
Heavy work remains serial under the unchanged one-CPU, 3 GiB early-stop / 4 GiB
hard memory, no-swap and host-availability guards.

## Main advanced during the experiment

Main subsequently advanced to `a2d8b94dd50dab8d966239dd63ab84718aa8b4b4`,
adding native Fiddler SAZ parsing. Its web-network capture contract already
offers opt-in summary and retained capture pages, archive-member coordinates
and exact exposed encoded bytes. It decodes all records before ordinal
selection and rejects malformed/oversized inputs without partial success.
Measure real public SAZ artifacts using these controls before adding another
API or changing decoding or credential-redaction semantics. SAZ performance
remains unverified in this Flutter continuation.

The Flutter cohorts keep their original frozen runtime; subsequent integration
onto this newer main does not relabel earlier measurement receipts.

Main advanced again to `bb154d106` during CI, adding retained aioquic 1.5.0
qlog 0.3 JSON parsing and qlog views. The existing capture summary/page path
already applies. Qlog's trace-scoped STREAM interval unions and endpoint loss
declarations have separate semantics: they do not recover bodies, prove network
loss or establish PCAP correlation. Measure genuine supported recordings and
existing retained views before adding delivery or caching. Other qlog layouts
and qlog performance remain unverified in the Flutter experiment. Shared-view
integration is checked after rebasing; earlier runtime receipts remain pinned.
