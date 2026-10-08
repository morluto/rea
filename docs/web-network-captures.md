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

## Reading the evidence

- `artifact` identifies the caller-selected file and stable snapshot digest.
- `records` preserve producer order/ordinals and original JSON pointers or byte
  ranges. No live browser transaction or scenario IDs are invented.
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

Generated free-text limitations follow the same literal declarations, including
global, per-record and Evidence explanations added during projection. Contract
field names, typed discriminators and exact decoder identities keep their
canonical meanings; declarations do not rename formats or providers.

Historical evidence does not prove runtime attribution, execution or deployment
authenticity. Mitmproxy messages are upstream-assembled messages, not recovered
wire fragments. Native dictionary duplicate keys have the unchanged upstream
decoder's last-value semantics; this adapter does not claim to recover discarded
duplicates or the original numeric spelling of parsed native floats.

## Resource and lifecycle boundaries

Complete evidence has a 32 MiB input, 96 MiB decoder reply and 64-level nesting
budget. Exceeding a budget returns no partial success.
Oversized selected captures return an input error identifying `capture_path`
and the byte budget; owned reply/output failures remain output or provider errors.
HAR runs in an owned
192 MiB Node old-generation heap with one V8 worker. Native decoding applies
Linux limits of 768 MiB address space, 30 seconds CPU and 96 MiB file output;
both commands have a 30-second wall deadline and independently supervised
process cleanup. Owned decoder diagnostics retain at most 1 MiB across stdout
and stderr; the collector drops overflow as it arrives, reports the limit
failure and verifies cleanup. Heap limits alone do not establish aggregate RSS limits.

Observed decoder memory exhaustion returns `resource_constraint`, with the
selected capture, applicable limits and retained process diagnostics. HAR's
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
