# Owned Playwright v10 recorder fixture

These two files contain unchanged NDJSON bytes from an actual local Playwright
1.64.1 recording on Linux, Node 24.22.1 and Chromium 156.0.8078.4. They are
stored with `.txt` suffixes to preserve producer JSON spelling and framing.

The owned loopback application redirects to a page, logs `fixture loaded`, then
loads JSON after a button click and logs its count. Requests intentionally use
`Authorization: Bearer FAKE_TRACE_CREDENTIAL`; the response sets the deliberately
fake `trace_session=FAKE_COOKIE` cookie. These are regression data, not real
credentials. The ordinary `X-Trace-Note` value must remain available.

Recording used `context.tracing.start({screenshots:true,snapshots:true,sources:false})`,
a new page, navigation through the redirect, one button click, a wait for the
result text, a screenshot, a 100-ms wait, and `context.tracing.stop({path})`.
The archive's SHA-256 was
`7a7e0210f0c815225b7b65e93a37f350e2e44061cd8cf6d8170479b79c0f0b87`;
it was 10,643 bytes with 11 members. The binary archive and image payloads are
not committed.

- `trace.trace.txt`: 51 physical lines; 6 before/6 after action boundaries,
  2 console messages, 6 screencast references, 11 frame snapshots, 17 logs,
  one input event, one browser event, and one context header.
- `trace.network.txt`: 3 resource-snapshot records, including the redirect and
  fetched JSON. The body references use v10 `_file` members.

`tests/fixtures/playwrightTrace.ts` reconstructs ZIPs from these original text
streams. Optional resource members are **opaque text markers**: they test
presence and ambiguity semantics and do not establish valid screenshots,
response bodies or recorder compatibility beyond the supplied stream facts.
Separate manual verification uses the original complete recorder archive.
Tests also create clearly identified malformed and partial variants.

The application and recording were created for this repository; no external
application code, credentials or screenshot binaries are included.

Exact text identities:

| File                |  Bytes | SHA-256                                                            |
| ------------------- | -----: | ------------------------------------------------------------------ |
| `trace.trace.txt`   | 10,654 | `27ecb5b6fd8582fce16fd47f68f6d12a582d9c45b9c02e4a1d69f933d2c228b3` |
| `trace.network.txt` |  5,981 | `cd7d35df7ea586f675c5e1818cc654d74722d8bb9f656843fa761e6e59406a20` |
