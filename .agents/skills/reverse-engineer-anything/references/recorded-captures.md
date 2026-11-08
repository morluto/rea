# Recorded captures and decoder discovery

## Historical web captures

Retained HAR/SAZ/native mitmproxy/aioquic qlog capture: `inspect_web_network_capture`. Select
original record ordinals when useful; inspect producer fields and byte/number
sidecars without fetching recorded URLs or claiming live attribution. For a decoder heap refusal, follow the reported `capture.decoder_old_generation_mib`
setting and bounds with `update_analysis_settings` (default 192 MiB, floor 8,
maximum 16384); the launch seed
`REA_CAPTURE_DECODER_OLD_GENERATION_MIB` affects future REA processes. Host memory
and `NODE_OPTIONS` do not raise that decoder allowance. See
[historical captures](https://github.com/morluto/rea/blob/main/docs/guides/web/web-network-captures.md) for the exact upstream
profile and credential exclusions. Qlog support starts with aioquic 1.5.0
JSON 0.3; stream coverage and endpoint loss declarations do not recover bodies
or establish network loss. Prefer detail summary, then kind qlog trace/stream
pages; select one trace, stream ID and direction for contribution/range pages.
Facts retain all-recorded-events-before-selection scope. Other qlog layouts
and PCAP correlation are unsupported.

## Packet fields and packet captures

Packet-field discovery: `inspect_packet_fields` searches installed protocols
and field names/types before choosing fields for `inspect_packet_capture`.
Query/page the relevant records; registrations do not establish observed traffic.

## Packet capture inspection

Recorded packet captures: `inspect_packet_capture` with selected TShark fields,
display filters and decode-as rules. Requires Linux, util-linux prlimit and
TShark 4.x on an absolute `PATH` entry or via the optional absolute
`REA_TSHARK_COMMAND` override; see
[capture guide](https://github.com/morluto/rea/blob/main/docs/guides/data/packet-captures.md).
Packet limits count input packets before filtering. Output defaults to 50 matching
frames; use `match_offset` / `match_limit` for later pages, or explicit null
limit for complete matching output. Preserve the source digest across pages.
This does not perform live capture.
For address/DNS/SNI/protocol summaries use `inspect_pcap_capture` with MCP
detail summary, then retained kind pcap pages. Requires Wireshark 4.x tshark
and capinfos, with Linux prlimit or Windows Job Objects; see
[packet summaries](https://github.com/morluto/rea/blob/main/docs/guides/data/pcap-analysis.md).
Select an exact DNS question for address pages; page exhaustion does not prove
network completeness. This reads recordings and does not acquire traffic.

## Signal decoder discovery

Decoder discovery: `inspect_signal_decoders` searches installed decoder IDs
or selected decoder help, including channels and options. Query and page the
relevant details before choosing settings; this does not scan hardware.

## Recorded logic and signals

Recorded logic/signal traces: `decode_signal_recording` with explicit decoder,
channel and protocol settings. On Linux with util-linux prlimit, supply sigrok-cli 0.7.2 through
`REA_SIGROK_COMMAND`; see [recording guide](https://github.com/morluto/rea/blob/main/docs/guides/signals/signal-recordings.md).
Output defaults to 50 literal lines; select annotation classes and page with
`line_offset` / `line_limit`, or explicit null for all remaining output.
Window counts are display lines, not annotations or samples. Preserve source digests across pages.
This reads existing files; it does not acquire hardware signals.
