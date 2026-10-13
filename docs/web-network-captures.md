# Historical web network captures

Use `inspect_web_network_capture` / `inspect-web-network-capture` to inspect
retained producer evidence. This is an offline operation: recorded URLs are
never fetched, and no browser or proxy listener is started.

```sh
rea inspect-web-network-capture /absolute/session.har har --json
rea inspect-web-network-capture /absolute/session.har har --record 2 --record 0 --json
```

```json
{
  "name": "inspect_web_network_capture",
  "arguments": {
    "capture_path": "/absolute/session.har",
    "format": "har",
    "record_ordinals": [2, 0]
  }
}
```

Omit ordinals to return every record. Explicit selection preserves caller order
and original zero-based producer ordinals; duplicate or out-of-range selections
are input errors. Every record is validated before selection, so selecting one
entry does not hide a malformed entry elsewhere.

For agent discovery over MCP, request `detail: "summary"`. REA retains the
complete selected Evidence in the session and returns identity and counts.
Use `normalized_result.parent_evidence_id` with `inspect_analysis_view`:

```json
{
  "source": {
    "kind": "retained-evidence",
    "evidence_id": "<parent_evidence_id>"
  },
  "view": { "kind": "capture", "detail": "preview", "offset": 0, "limit": 20 }
}
```

Preview pages select recorded HTTP headline fields, event names/times when
present, original locations and byte descriptors; they omit headers, XML and
payload content. Choose `detail: "complete"` in that view for exact record
pages, including all sidecars. Offsets follow the parent's selected record
order; producer ordinals remain unchanged. `total_records` counts the original
capture while `retained_records` and page coverage count records in the parent.
An exhausted page does not establish absence from unselected records.

Views do not reopen the file or rerun its decoder. They remain historical
Evidence if the source changes or disappears; inspect the capture again to
observe new bytes. The inspection tool's default `detail: "complete"` preserves
existing inline delivery. For CLI use, save complete inspection JSON and pass
it as inline Evidence to `inspect-analysis-view`; the same summary and capture
page contracts apply. Large complete records can still exceed MCP's response
budget; export the retained Evidence when a single record cannot fit.

## Formats and upstream profiles

HAR uses unchanged `har-schema@2.0.0` draft-06 schemas, `ajv@8.20.0`,
`ajv-formats@3.0.1`, `jsonc-parser@3.3.1` JSON visitor, and
`lossless-json@4.3.1` numeric representations, pinned in the npm lockfile.
Only the HAR 1.2 profile is supported. Unknown extensions remain reported
evidence. Duplicate object keys, including equal values and escaped spellings,
are rejected before materialization. Prototype-named members such as
`__proto__` are preserved as ordinary own JSON members without prototype
mutation. Original capture files remain unchanged.
The observed mitmproxy 12.2.3 `SaveHar` profile can emit `postData.text: null`
for a missing request body. REA preserves that reported null, omitting the
optional field only from its validation copy for this exact producer profile;
it does not invent an empty string or body bytes.

Native mitmproxy decoding requires a caller-supplied **mitmdump 12.2.3 on
Linux**. Set its absolute executable path:

```sh
REA_MITMDUMP_COMMAND=/absolute/mitmdump rea inspect-web-network-capture /absolute/session.mitm mitmproxy --json
```

REA does not install mitmproxy. Its owned process uses a private configuration
directory, `--no-server`, and the unchanged upstream `mitmproxy.io.tnetstring`
decoder. It does not run `FlowReader` migrations or convert native states to
HAR. Raw IDs, state versions, flow types, backup states and unknown extensions
are preserved without synthesizing connections, timestamps or content. The
tested upstream source is tag `v12.2.3`, commit
`6c09d56e4c29a92f5ad01b03199977584b8ea14f`; other native tool versions return
an explicit unsupported-profile diagnostic. Non-Linux native decoding is not
supported by this adapter.

## Reading Fiddler captures (`.saz`)

Fiddler Everywhere saves traffic in **Session Archive Zip (`.saz`)** files.
Inspect native SAZ directly, without installing Fiddler or converting to HAR:

```sh
rea inspect-web-network-capture /absolute/session.saz saz --json
rea inspect-web-network-capture /absolute/session.saz saz --record 0 --json
```

MCP uses the same `capture_path`, `format: "saz"`, and optional
`record_ordinals` fields as the examples above. REA pairs `raw/<id>_c.txt`
requests, `_s.txt` responses, and `_m.xml` metadata by filename stem. Archive
member names identify the source; zero-based ordinals follow each session's
first member in ZIP directory order, not its numeric ID or capture time.

HTTP fields and ordered duplicate headers are retained, with stored body bytes
in binary sidecars. Bodies are not dechunked or decompressed. Metadata is an
XML node tree; optional `_w.txt` and `_g.txt` files retain opaque WebSocket and
gRPC message bytes. Missing members remain null, distinct from empty bodies.
See Telerik's [SAZ format reference](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/knowledge-base/fiddler-archives).

The existing ZIP reader verifies read members; expanded archive contents are
limited to 32 MiB in addition to the input/output budgets below. Encrypted
archives and unrecognized raw session members are unsupported. SAZ requires an
enforced decoder memory bound: Node's fixed heap, or the Windows Job Object
commit limit. Bun on hosts without that Job Object limit returns capability
unavailable before starting the SAZ decoder. Non-session
members are inventoried without decoding their content. Original files remain
unchanged. Linux verification includes independently checked public recorded
Mattermost captures from [FOREST](https://github.com/dfrc-korea/FOREST/tree/405c9154658a128ea203a6c10040cec55111ed03/api-results/dataset)
and the Fiddler author's [encoding corpus](https://github.com/ericlaw1979/Clearinet/blob/b6faf78cde1e72042980364f180ceb34b77d1434/Test/data/Encodings.saz),
plus synthetic malformed/limit fixtures. Their exporting product versions are
not authenticated. An interactive export from a current Fiddler Everywhere
installation and its live MCP server remain unverified. Support here is the
bounded documented raw HTTP/XML SAZ layout, not every product/version profile.

For visual inspection, use Everywhere's **Import Snapshot**, then **Inspectors**
and **Overview**. HAR remains an alternative: select sessions, choose
**Export > HTTPArchive**, and confirm `log.version` is `"1.2"`. Preserve the
original SAZ when exporting. See the [import/export instructions](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/collaboration/exporting-and-importing).

## Fiddler Everywhere MCP and public skills

For agent-driven traffic debugging, connect Everywhere's MCP server separately
from REA. Run a current Everywhere release with MCP access (Trial, Pro, or
higher), internet access, and a compatible MCP client. Use
**Settings > MCP Server > Coding agent**, or **Manual setup** with the generated
API key. The default endpoint is `http://localhost:8868/mcp`. See Telerik's
[MCP setup guide](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/agent-tools/fiddler-mcp-server)
and [agent-skills prerequisites](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/agent-tools/agent-skills).

Telerik's [public skills](https://github.com/telerik/fiddler-agent-tools) cover
installation (`fiddler-download-setup`), connection setup, and traffic analysis:

```sh
npx skills add telerik/fiddler-agent-tools --skill fiddler-mcp-setup
npx skills add telerik/fiddler-agent-tools --skill fiddler-traffic-debugging
```

After setup, reload the agent client and use the connected server's advertised
tool names and schemas. Check status, list sessions, then inspect relevant
session IDs. Set `sessionsSource` to `LiveTraffic` for HTTP(S) traffic or
`AgentCalls` for enriched LLM calls; active filters affect the session list.
For an existing run, skip the skill's pre-capture steps that replace process
filters and clear sessions. The documented MCP session sources do not provide
a saved-snapshot selector; use the SAZ workflow above for saved files. REA does
not register or wrap the Fiddler MCP server.

## Reading the evidence

- `artifact` identifies the caller-selected file and stable snapshot digest.
- `records` preserve producer order/ordinals and original JSON pointers, byte
  ranges, or SAZ member names. No live browser transaction or scenario IDs are invented.
- `reported` retains the producer's fields. HAR container metadata is returned
  separately, with `log.entries` replaced by `null` and `records_pointer`
  identifying the record collection. This is an inspection representation,
  not a reconstructed HAR file.
- `numeric_literals` preserve HAR number lexemes and native integer/float
  representations, including unsafe integers and non-finite native floats.
  Values that cannot be safely represented as JSON numbers are `null` in the
  reported view. Unsafe standard HAR numeric fields fail schema validation;
  unsafe extension numbers remain available through their sidecars.
- `binary_fields` retain exposed bytes, base64 and SHA-256 independently of
  declared sizes. Valid HAR `content.encoding: "base64"` is decoded exactly;
  producer-decoded Unicode text, missing text and unknown encodings do not
  establish original body bytes. Post-data parameters do not reconstruct a
  multipart body. Native byte fields also have an exact UTF-8 display view
  when valid; binary sidecars establish their actual representation. Native
  missing content and empty content remain distinct.
- `redactions` identify known transport authentication exclusions and explicit
  sensitive-value exclusions. Redacted byte fields retain neither original
  bytes nor their digest. Unknown extension names and token-looking query
  parameters do not establish sensitivity.

Mark sensitive literal string/UTF-8 byte values with MCP `sensitive_values`, or
repeat CLI `--sensitive-value`. These declarations are never persisted in
Evidence parameters; the count is retained. Explicit text/UTF-8 byte matches
exclude the entire field with a reported `null` rather than substitute a text
marker or rewrite payload bytes. This prevents replacement markers from
reintroducing declared literals. The file digest identifies the original artifact
unless it matches an explicit declaration; in that case `artifact.sha256` and
Evidence `subject` are null with an explanation. A sensitive property name excludes that
entire property and its sidecars; a `scope: "property-name"` redaction points
to its actual parent. No substitute property name or child pointer is invented.
Omitted subtrees are still validated, including canonical HAR base64. Explicitly sensitive artifact
paths are empty in Evidence and omitted from locations, while the original
SHA-256 and size remain available unless the digest itself is explicitly excluded. Failure messages, diagnostics and cleanup
resources follow the same explicit declarations without changing error types;
sensitive issue pointers identify a real ancestor instead of a fabricated
coordinate. Header/cookie authentication values and known
transport URL userinfo are excluded structurally, including native backups.
HAR redaction and API-surface projection share the same recorded-URL parser.
Canonical userinfo spans are removed without rewriting the remaining source
text. Credential-bearing spellings without a safe raw span, such as slashless
or extra-slash HTTP URLs, are excluded as a whole transport field. Ordinary
extension text and noncredential path/query values remain unchanged.

Generated free-text limitations follow the same literal declarations, including
global, per-record and Evidence explanations added during projection. Contract
field names, typed discriminators and exact decoder identities keep their
canonical meanings; declarations do not rename formats or providers.

Historical evidence does not prove runtime attribution, execution or deployment
authenticity. Mitmproxy messages are upstream-assembled messages, not recovered
wire fragments. Native dictionary duplicate keys have the unchanged upstream
decoder's last-value semantics; this adapter does not claim to recover discarded
duplicates or the original numeric spelling of parsed native floats.

## Derived API surface

Pass retained HAR Evidence to `inspect_analysis_view` with
`view: {"kind":"api-surface","offset":0,"limit":50}`. Omitted offset and limit
are 0 and 50. The view groups request lines by method, WHATWG URL origin and
path template, sorted by origin, template and method. Query strings, fragments,
credentials, headers and bodies are not copied into groups.

| Rule       | Exact segment format                                 | Placeholder  |
| ---------- | ---------------------------------------------------- | ------------ |
| `numeric`  | ASCII digits only                                    | `{numeric}`  |
| `uuid`     | RFC 9562 textual UUID, any version, case-insensitive | `{uuid}`     |
| `hex`      | At least 32 hexadecimal digits                       | `{hex}`      |
| `iso-date` | Valid calendar date `YYYY-MM-DD`                     | `{iso-date}` |

Rules apply in table order to the recorded, still-encoded request path, read
before WHATWG dot-segment removal, so `/a/%2e%2e/admin` and `/admin` stay distinct. Segment indexes start
at zero after the leading slash. Each matched segment lists its observed literals
and `basis: "inferred"`. `templated_groups` counts templated groups across every
page. Because paging follows the full grouping, every page is inferred Evidence
when that count is nonzero, and derived Evidence only when no group was templated. Version prefixes, short opaque IDs
and digit-bearing route names stay literal. Samples merge only when method,
origin, and exact segment rules match. The view does not infer further
cross-sample patterns.

Groups cite parent record ordinals and distinct statuses and MIME types (lowercase
type/subtype without parameters). An invalid type/subtype essence is unknown;
parameters do not affect this projection. Flags report single samples, mixed
statuses or mixed content types.
`coverage` pages groups; `records` separately reports examined, total and excluded
parent records. Ordinal subsets carry a limitation. Null URLs are excluded as
`url-redacted`; unparseable URLs, URLs without an origin, spellings without
`scheme://authority` (such as `https:host/path`), and authorities containing a
tab or newline as `url-unparseable`.
Unavailable request objects or methods are explicitly excluded. Unavailable
response fields, including HAR's `status: 0` and an empty `mimeType`, remain
unknown, not invented statuses or MIME types.

The view makes no handler-identity, schema or causality claim. It performs no
network activity. Native mitmproxy, SAZ and qlog captures return a typed unsupported error.
Parents inspected with `sensitive_values`, or whose Evidence does not record
`sensitive_value_count`, return a typed unsupported error whose reason is the
canonical token `sensitive_values_unretained`. The view would write path
templates and limitation text that it cannot check against declarations the
parent does not retain, so the refusal does not repeat declaration text.

One accumulator owns group identity, observed-value/status/MIME sets, ordinals,
exclusions and deduplicated limitations. It scans path spans without splitting
literal paths into arrays. Before schema parsing, it reserves the capture clone
and validation scratch by walking the parent without cloning it. Inline requests
borrow the Evidence value through CLI/MCP envelope validation; the application
admits the entire portable envelope before authenticated parsing or hashing.
The envelope clone, hash scratch and capture clone stay charged during grouping.
Temporary URL/path/MIME work and retained state must
fit together within a 96 MiB projection representation budget. A whole group or
merge is admitted before allocating its retained sets, map entries or array
values. Fixed group storage, distinct text, exclusions and limitations count as
well as matched segments. Per-record reservations are released after each
record; repeated values do not accumulate another retained charge. Only the
requested page is materialized as output groups.

The representation budget uses conservative storage and worst-case JSON-escaping
allowances; it is not an enforced V8 heap or process-memory limit. It is separate
from the decoder's actual reply-byte limit and MCP transport admission. Exceeding
it returns `resource_constraint` without a partial view. Limitations on the
parent envelope, capture and examined records are deduplicated onto the view.
Portable captures must retain unique ordinals within their declared total;
caller-selected subsets can preserve any requested ordinal order.

## Resource and lifecycle boundaries

Complete evidence has a 32 MiB input, 96 MiB decoder reply and 64-level nesting
budget. Exceeding a budget returns no partial success.
Oversized selected captures return an input error identifying `capture_path`
and the byte budget; owned reply/output failures remain output or provider errors.
HAR, SAZ and qlog run in an owned
192 MiB Node old-generation heap with one V8 worker. Mitmproxy decoding applies
Linux limits of 768 MiB address space, 30 seconds CPU and 96 MiB file output;
both commands have a 30-second wall deadline and independently supervised
process cleanup. Owned decoder diagnostics retain at most 1 MiB across stdout
and stderr; the collector drops overflow as it arrives, reports the limit
failure and verifies cleanup. Heap limits alone do not establish aggregate RSS limits.
SAZ and qlog refuse decoding when neither a Node heap limit nor a Windows Job Object bound can be enforced. Existing HAR availability is preserved.
When REA runs on Bun, the HAR/SAZ/qlog decoder runs on Bun, which ignores these V8 heap
flags; its limitations and resource failures then omit the heap sizes. On
Windows, the decoder's owned Job Object instead limits its committed memory to
704 MiB, the 192 MiB budget plus a 512 MiB reserve for Bun itself. The
limitations state that limit, and reaching it returns `resource_constraint`
with `process_memory_limit_bytes`, whatever exit status Bun reports.

Observed decoder memory exhaustion returns `resource_constraint`, with the
selected capture, applicable limits and retained process diagnostics. HAR/SAZ/qlog's
old-generation heap is fixed; inherited `NODE_OPTIONS` cannot raise it.
Record selection happens after complete decoding and does not reduce that
workload. Use a smaller capture exported by its producer or another decoder
with sufficient capacity, retaining the original for provenance. Subsets do
not establish complete-capture coverage. Repeating the same workload or
running provider health diagnostics does not resolve the heap constraint.

Stable regular-file reads reject symlinks, replacement and concurrent changes.
Private snapshots, declarations and tool configuration are removed before the
result returns. Cleanup uncertainty retains the selected capture, resource and
original failure information. The original capture is never changed.

## Excluded coordinates and read failures

Explicitly marked values also exclude matching source coordinates and their sidecars. A hidden record coordinate is reported as `location.kind: "unknown"`; REA does not invent a replacement pointer. Original record ordinals and artifact digests remain available.

Host filesystem read denials return `code: "access_denied"`, `category: "unavailable"`, the actual `EACCES`/`EPERM` code and read-access guidance. Missing files remain input failures. Cleanup failures retain the prior structured error, including its input constraints or provider diagnostics, with explicitly marked text excluded.

An observed replacement or in-place change during stable artifact acquisition
returns `code: "artifact_changed"`, `category: "integrity_mismatch"` and
`retryable: true`, retaining the selected path and reader's reason. Wait until
the capture file is stable before retrying. No unstable snapshot is decoded.
Command cleanup failures retain the original status and both diagnostic streams;
the decoder's ownership preparation receives the same cancellation signal.

MCP advertises the same strict named input contract used by the application. Historical inspection delegates argument validation to that shared application boundary so accepted explicit-sensitive declarations also cover invalid argument names and other correction details. The SDK receives raw arguments through its Standard Schema interface; malformed inputs still fail before decoder or filesystem effects and return the normal structured REA error. Protocol-envelope validation remains owned by MCP.

## Retained aioquic qlog

Select `format: "qlog"` through `inspect_web_network_capture`, or:

```bash
rea inspect-web-network-capture /absolute/origin.qlog qlog --json
rea inspect-web-network-capture /absolute/origin.qlog qlog --record 95 --record 0 --json
```

The initial profile is **aioquic 1.5.0, JSON qlog 0.3**: one JSON object with
`qlog_format: "JSON"`, `qlog_version: "0.3"`, `traces` containing object events
with `name`, finite numeric `time` and object `data`. JSON-SEQ, JSONL, columnar
array events and other versions are unsupported. Duplicate JSON members,
malformed UTF-8, invalid interpreted QUIC integers and excessive nesting fail
without partial success, including in events outside the selected ordinals.
Well-formed event subsets and missing frame metadata remain inspectable.
Unknown extensions are retained; this is not validation of every qlog schema.

Choosing the format selects the interpretation profile; the file does not
necessarily report or authenticate an aioquic version. The profile's clock
uses Unix-epoch milliseconds, verified in aioquic 1.5.0's `QuicLoggerTrace`
`log_event`/`encode_time`. The `qlog.clock.basis` and Evidence analysis profile
state that assumption explicitly. Numeric lexemes survive independently of
safe JSON-number projections; decimal spelling does not establish physical
clock precision or monotonicity.

Every event has a global ordinal from trace/event source traversal and its
original `/traces/T/events/E` pointer. This order is not a global time sort.
Trace index and the selected artifact identify a connection observation;
reported ODCID is preserved without claiming global uniqueness. Streams are
scoped by trace, stream ID and sent/received direction. Control/QPACK streams
are retained, so counting streams does not count HTTP requests.

`qlog` is a typed facet required exactly for this format. Its scope is
`all-recorded-events-before-selection`: selection changes returned event
records while facts cite the original ordinals across the entire recorded
file. The container retains trace metadata with each events array replaced
by null; there is no single events pointer shared by all traces.

| Fact                                | Basis and limits                                                                                                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original event and loss declaration | Observed endpoint report; `recovery:packet_lost` does not prove actual network loss. Missing packet number/type remains unknown.                                                                                                                                              |
| STREAM ranges and byte totals       | Derived per trace and direction from reported offsets and lengths using exact integer arithmetic. `unique_bytes` unions intervals; `frame_length_sum` includes overlaps; `repeated_bytes` is their difference. Overlap alone does not prove retransmission or equal contents. |
| FIN final sizes                     | Reported offset plus length where FIN is true; multiple conflicting sizes remain visible. A final size does not establish complete coverage or a received body.                                                                                                               |
| Incomplete fact records             | Ordinals with omitted/redacted interpretable frame metadata; usable fields in other records survive. An empty list does not establish complete logging or capture.                                                                                                            |
| HTTP bodies and causality           | `body_bytes: "not-reported"`; lengths and headers are metadata, with no reconstructed body, hash, timing causality or live process attribution.                                                                                                                               |

QUIC integer fields interpreted here accept exact nonnegative JSON integer
values through `2^62 - 1`, including equivalent exponent notation. Offsets plus
lengths must fit that range. Derived sums are decimal strings and are not
rounded to JavaScript numbers. A missing offset is unknown, never defaulted to
zero. Ranges can start above zero or contain gaps. Packet headers, HTTP events,
raw lengths and unknown extensions remain producer evidence rather than being
normalized into invented HAR requests.

The adapter excludes authorization/proxy authorization/cookie/set-cookie
values in known HTTP frame events, reset tokens in transport parameters and
NEW_CONNECTION_ID frames, and NEW_TOKEN frame tokens. Known URL header userinfo
and explicit sensitive values follow the shared exclusions. Ordinary extension
fields and token-looking query text remain retained. Explicit declarations also
cover normalized numeric projections, derived totals and trace pointers; facts
that cannot be safely shown are omitted with incomplete-record coordinates.
No keylog, PCAP, live URL or recorded target is opened by the qlog decoder.

To repeat the real-provider lane with **local caller-supplied evidence** from
the educational aioquic 1.5.0 experiment (one origin trace, known 32,803-byte
stream coverage and one 1,169-byte repeated range in the loss case):

```bash
npm run verify:web:qlog -- /absolute/control/origin.qlog /absolute/loss/origin.qlog /absolute/new-report.json
```

This lane checks built CLI/stdio MCP parity, SDK-converted JSON Schemas,
artifact digests, original event count, selection scope, retained parent lookup,
credential exclusions and the known control/loss facts. The report is created
exclusively and contains no keys or captured credential values. It is a
fixture-specific verification, not a general loss detector. CI uses synthetic
format inputs for malformed cases and limits; those tests do not establish
producer provenance. PCAP parsing and correlation remain outside this stage.

### Focused qlog views

Use MCP `inspect_web_network_capture` with `format: "qlog", detail: "summary"`
for identity, profile, scope and retained-fact counts. Then pass its
`normalized_result.parent_evidence_id` to `inspect_analysis_view` as a
`retained-evidence` source.

```json
{"kind":"qlog","facet":"traces","offset":0,"limit":10}
{"kind":"qlog","facet":"streams","trace_index":0,"offset":0,"limit":10}
{"kind":"qlog","facet":"contributions","trace_index":0,"stream_id":"0","direction":"sent","offset":0,"limit":20}
```

Trace pages omit nested lists and give their counts. Stream pages preserve
exact byte totals but omit contributions, ranges and final-size lists. For
those lists select `contributions`, `ranges` or `final-sizes` with all three
stream selectors. `loss-declarations` and `incomplete-records` need only
`trace_index`. Offsets count rows in that retained facet; defaults are 0 and 64. Missing or ambiguous selectors fail rather than choosing a connection.

These views page already interpreted facts without decoding again or opening
the source, and work after its deletion. Facts still cover all recorded events
before parent record selection. Their exhaustion does not prove logging or
network completeness. Event preview/complete pages remain available through
kind `capture`, with original numeric lexemes and producer ordinals preserved.
