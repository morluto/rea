# Packet capture summaries

REA summarizes already saved pcap/pcapng files through caller-selected Wireshark
4.x `tshark` and `capinfos`. Use `inspect_packet_capture` for selected fields,
filters and decode-as rules; use this family for address, DNS, SNI, protocol-stack
and URI inventories. It does not acquire traffic or fetch recorded targets.

## Supply tools

```sh
export REA_TSHARK_COMMAND=/absolute/path/tshark
export REA_CAPINFOS_COMMAND=/absolute/path/capinfos
# Linux only; default /usr/bin/prlimit
export REA_TSHARK_PRLIMIT_COMMAND=/absolute/path/prlimit
rea inspect-pcap-client
rea inspect-pcap-capture /captures/session.pcapng --json
```

Without explicit tool commands, this family resolves them through PATH and
records that selection source. Client inspection reads no capture file. Capture
inspection requires Linux with util-linux prlimit or Windows with owned Job
Objects. macOS capture inspection returns a capability gap because the new
native memory boundary is unverified; its version probes remain available.
Tools and installed libraries/plugins are caller-trusted. An empty private
personal Wireshark configuration is used; this is not an OS sandbox.

## Inspect only the needed facts

MCP `inspect_pcap_capture` accepts `path` and optional `detail: "summary"`.
Complete delivery remains the default. Summary commits and retains the same
complete Evidence, returning identity, capture metadata, observed counts,
retained counts, source coverage and diagnostic lengths without large lists.
Then use its `normalized_result.parent_evidence_id` with
`inspect_analysis_view` source kind `retained-evidence`:

```json
{"kind":"pcap","facet":"endpoints","offset":0,"limit":20}
{"kind":"pcap","facet":"dns-queries","offset":0,"limit":20}
{"kind":"pcap","facet":"dns-addresses","query":"example.com","offset":0,"limit":20}
{"kind":"pcap","facet":"tls-sni","offset":0,"limit":20}
{"kind":"pcap","facet":"diagnostics","stream":"tshark","offset":0,"limit":4096}
```

Other row facets are `protocols`, `http-uris` and `unattributed-addresses`.
Defaults are offset 0 and limit 64. DNS question pages give address counts;
select one exact retained question to page its addresses. Diagnostic windows
count UTF-16 code units; other windows count rows. Missing/ambiguous selectors
fail. Unknown legacy diagnostics remain unknown, not an observed empty stream.
Portable CLI views use the existing `inspect-analysis-view` workflow with inline
complete Evidence. Views never reread the source or launch Wireshark and work
after the original file is deleted. Page exhaustion covers the retained facet;
it does not establish network completeness or recover missing traffic.

## Interpret provenance and coverage

`target.sha256` binds observations to an admitted stable capture snapshot. Both
tools read that copy, which is hashed again after analysis. Capture metadata and
literal field values are producer observations; address/protocol counts and DNS
associations are derivations. Capture Evidence has historical-reference authority.

Addresses count once per packet, including loopback and nested IP occurrences.
DNS addresses are associated only with one question in the same response packet;
additional records may be included, so this does not prove final resolution.
Ambiguous addresses remain in a separate inventory. Protocol distribution counts
exact `frame.protocols` stack strings. TLS SNI is recorded handshake metadata,
not process identity or proof of the destination's authenticity.

All examined inventories are retained within the resource budget; no fixed
200/100/50-item truncation is applied. HTTP transport credentials are excluded
without rewriting other URI bytes; ambiguous credential spans cause omission.
Counts preserve distinct observed source URIs before omission or coalescing.
`coverage: "partial"` records unresolved DNS attribution or URI item loss;
component credential exclusion is also counted explicitly. Diagnostics retain
both tool stderr streams. Recorded fields do not establish decrypted payloads,
causality, process identity, absence of unrecorded traffic or current deployments.

## Resources and lifecycle

One inspection is admitted at a time per provider. Concurrent calls return a
capacity error; close drains active work before releasing resources. Captures
are streamed into a read-only owned snapshot with a 2 GiB disk budget. Native
capture commands enforce Linux address-space ceilings of at most 1 GiB,
300 CPU seconds, 64 MiB per file and no core dumps, preserving stricter inherited
limits. Windows uses a 1 GiB committed-memory limit for each owned tool tree.
These are not aggregate machine or filesystem quotas.

TShark output is bounded at 8 MiB; its known five-level selected-field shape and
128 MiB graph-expansion estimate are checked before allocation. Retained facts
have a separate 16 MiB estimate. Capinfos output is limited to 64 KiB. Command
wall deadlines are 300 s for dissection, 60 s for metadata and 20 s for probes.
Native ownership preparation has its own bounded lifecycle.

Malformed/oversized output returns no partial success. Unvalidated partial JSON
is not returned as facts. Cancellation reaches probes, acquisition, commands and
projection. Cleanup failure returns a typed error, retains completed Evidence
when available, and retains owned resources for retry on close.

## Verification scope

Current follow-up verification uses Linux/Node 24.18.0 and Wireshark 4.0.17.
Private real recorded corpora are checked against independent raw-frame/IP
parsing and Python aggregation, public CLI/stdio MCP parity, SDK schemas, source
hashes and retained views. Synthetic native tools separately test malformed
output, cancellation, source/snapshot mutation, capacity and cleanup; they do
not establish real Wireshark or other-platform behavior.

The original proposal reported Linux 4.6.6, macOS/Windows 4.6.9 verification on
its earlier implementation. Those reports do not verify the new final memory
boundary. Actual Windows/Bun Wireshark execution is unverified here; macOS
capture support needs a separate enforceable-bound decision.

```sh
npm run verify:pcap -- --pcap /absolute/saved-capture.pcapng
```

This verifier exercises built CLI/stdio MCP, schemas, artifact identity and
cleanup. Without `--pcap`, capture inspection is reported as unverified. Private
captures, keys and provider runtime files are not committed.
