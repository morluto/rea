# Verify real HTTP/3 MITM captures

This optional Linux laboratory checks native mitmproxy captures through REA's
public CLI and MCP. It changes no runtime contracts or adapters and establishes
only the specific producer, mode and clients exercised here.

## Prepare a disposable guest

The exercised image is [Omarchy 4.0.4, build 440](https://nightly.omarchy.org/stable/4.0.4/440/omarchy-4.0.4.qcow2),
SHA-256 `43412b896fe3d730e373a51a8acf99343d7c3e6dee78aa9f9bd7fca181127264`.
Download it without installing guest packages on the host, check its digest,
and use a **new qcow2 overlay** with that file as a read-only backing image.
The matching [boot artifacts](https://nightly.omarchy.org/stable/4.0.4/440/unpacked/)
include the kernel, initrd, cmdline and upstream vm-boot recipe. Use a fresh SSH
key, loopback forwarding and guest disk; do not reuse another investigation's
writable overlay or host trust configuration. Shut the guest down before
switching overlays. Preserve the image and boot artifact hashes with evidence.

This sealed guest already supplies cURL 8.22.0 with OpenSSL 3.6.4, ngtcp2 1.25.0,
nghttp3 1.18.0 and nghttp2 1.70.0. **No guest rolling package upgrade is needed.**
Run `curl --version` and verify HTTP2 and HTTP3 features before starting. A stock
cURL from another distribution may omit HTTP/3. For a different guest, building
cURL requires a compatible TLS library, ngtcp2 and nghttp3; follow the
[official build instructions](https://curl.se/docs/http3.html), install to a guest
private prefix, and record exact source revisions and build inputs. That alternative
has not been exercised by this laboratory; it is not the pinned reproduction path.

Use a fresh VM overlay over a sealed Linux image. Use user-mode networking with
SSH forwarding bound to host loopback; keep host directories unmounted. Install
and build dependencies inside the guest, then remove its default route before
generating traffic. Host trust, routes and installed packages stay unchanged.

Record the image digest, REA source revision and these dependency versions:

- REA's `.nvmrc`, `package.json#packageManager` and locked npm dependencies.
- Official Linux x86_64 mitmproxy **12.2.3** standalone archive. SHA-256:
  `2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5`.
- A private Python virtual environment using the complete pinned graph in
  `scripts/fixtures/http3-lab-requirements.txt`. Save `pip freeze` and build/download logs.
- OpenSSL and cURL advertising HTTP3 and HTTP2 in `curl --version`.

The verified guest used Python 3.14.7, cURL 8.22.0, ngtcp2 1.25.0 and nghttp3
1.18.0. The current requirements update certifi from 2026.7.22 to 2026.10.19
to remove the compromised emSign trust root described in
[GHSA-6q48-6c7w-9gw2](https://github.com/certifi/python-certifi/security/advisories/GHSA-6q48-6c7w-9gw2).
The revised dependency graph has not been rerun in that sealed guest; the
historical verification does not cover this update. Other dependency profiles
need verification. Back up the guest's
`/etc/hosts` before adding `127.0.0.1 lab.test`. Reserve guest TCP/UDP loopback
ports 18443 and 19443. These changes belong only to the disposable guest.

From the guest REA checkout, use its pinned Node/npm toolchain:

```sh
npm ci
npm run build:cached
python3 -m venv /absolute/lab/venv
/absolute/lab/venv/bin/pip install --no-deps -r scripts/fixtures/http3-lab-requirements.txt
/absolute/lab/venv/bin/pip check
/absolute/lab/venv/bin/pip freeze > /absolute/lab/python-requirements.txt
```

Before removing the guest default route, download the official mitmproxy archive
and verify it, then extract to the guest's private tools directory:

```sh
mkdir -p /absolute/lab/tools
curl --fail --location https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz \
  --output /absolute/lab/mitmproxy.tar.gz
printf '%s  %s\n' 2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5 \
  /absolute/lab/mitmproxy.tar.gz | sha256sum --check --strict
tar -xzf /absolute/lab/mitmproxy.tar.gz -C /absolute/lab/tools
/absolute/lab/tools/mitmdump --version
```

Pin the REA revision with `git rev-parse HEAD` or archive SHA-256. Build using
the exact `.nvmrc` and npm version; do not copy a different checkout's `dist`.
For stronger offline dependency reproduction, preserve downloaded Python
archives, their digests and built wheels along with the image and toolchain.
The requirement versions pin the runtime graph, not every transient build tool;
source builds and alternate interpreters are not guaranteed byte-identical.

## Run the narrow profile

Select absolute executables and a new evidence directory. The producer refuses
to reuse a directory. No certificates are installed in a system trust store;
clients and proxy receive explicit paths to freshly generated test CAs.

```sh
REA_MITMDUMP_COMMAND=/absolute/lab/tools/mitmdump \
REA_HTTP3_PYTHON_COMMAND=/absolute/lab/venv/bin/python \
npm run verify:web:http3 -- /absolute/evidence/run-1
```

The producer sends three concurrent binary POSTs on one HTTP/3 connection to the
same URL through mitmproxy reverse mode to an aioquic HTTP/3 origin. The origin
waits for all complete requests, then dispatches responses in reverse order of
completion at the origin. QUIC stream send/receive orders need not coincide. A cURL HTTP/3-only
request checks a second client implementation. Mitmproxy's real save addon
writes `normal.mitm`; no native flows are synthesized.

A second proxy run disables HTTP/3. cURL `--http3` falls back to HTTP/2, reaching
an HTTP/1.1 TLS test origin. `fallback.mitm` must retain those lower protocols,
so a successful HTTP request cannot masquerade as an HTTP/3 success.

## Optional origin stream reset

Add `--with-origin-reset` to exercise one failure and recovery case with the
same producer, dependency pins and isolation requirements:

```sh
REA_MITMDUMP_COMMAND=/absolute/lab/tools/mitmdump \
REA_HTTP3_PYTHON_COMMAND=/absolute/lab/venv/bin/python \
npm run verify:web:http3 -- /absolute/evidence/reset-1 --with-origin-reset
```

A separate proxy run writes `origin-reset.mitm`. After receiving a complete
binary request, the origin resets its response stream with
`H3_REQUEST_CANCELLED` (0x10c) before sending response headers. The client must
observe that stream reset with the same error code; a timeout, connection close
or successful response fails this scenario. The client then sends another
request on the same connection and verifies its successful binary response.

Acceptance compares the failed flow's exact producer error, complete request
bytes and headers, null response and absent response binary fields through both
CLI and MCP. The recovered flow must preserve exact request/response bytes,
headers and producer connection facts. Both flows must share each leg's
connection UUID; endpoint observations independently verify distinct streams on
the same QUIC v1 connections. Stream IDs remain scoped to their own endpoints,
without requiring equality across the proxy.

`--inspect-existing` automatically checks this scenario when its manifest contains
it. Adding `--with-origin-reset` also requires it to be present, so inspecting an
older capture cannot silently satisfy a requested reset verification. Existing
normal/fallback captures remain usable without the new option. The scenario also
participates in input immutability, session retention and cleanup checks.

This option covers an origin reset before headers and subsequent
same-connection recovery only. The optional partial-response profile below
covers a different failure point. Client cancellation, other reset codes and
connection-wide failures remain separate increments.

## Optional partial response followed by reset

Add `--with-partial-reset` to exercise a streamed response interrupted after
an acknowledged binary prefix. It can run alone or with `--with-origin-reset`:

```sh
REA_MITMDUMP_COMMAND=/absolute/lab/tools/mitmdump \
REA_HTTP3_PYTHON_COMMAND=/absolute/lab/venv/bin/python \
npm run verify:web:http3 -- /absolute/evidence/partial-1 --with-origin-reset --with-partial-reset
```

The separate `partial-reset.mitm` producer run sends HTTP/3 status 200 and
`content-length: 32`, followed by exactly 21 binary bytes without FIN. The
observer addon selects response streaming only for this case; the proxy keeps
`store_streamed_bodies=false`. The origin waits for an application-level signal
that the client actually received the entire 21-byte prefix before issuing
`H3_REQUEST_CANCELLED`. It uses no fixed delay to infer delivery. A subsequent
request on the same connection must complete normally.

Acceptance independently compares the sent and received prefix, its exact
bytes and digest, the declared length, headers and endpoint-local stream
coordinates. The client must report no completed response for the failed
stream. A timeout, connection termination, premature FIN, missing prefix or
recovery through another connection fails the check.

The native capture is checked against the UUID-matched producer error through
CLI and MCP. It must retain the HTTP/3 response headers and status 200, with
`response.timestamp_end: null` and `response.content: null`, and no response
content binary descriptor. Null denotes an absent stored body, not an empty
body or recovered partial bytes. The endpoint journal contains the prefix;
REA does not reconstruct it from the native capture or infer successful
completion from status 200. This profile does not exercise buffered partial
responses or `store_streamed_bodies=true`.

`--inspect-existing` automatically checks the partial scenario when present in
the manifest. Supplying `--with-partial-reset` requires its presence and fails
before analysis if it is missing. Both reset scenarios use the same request,
connection, endpoint recovery, schema, Evidence retention, input immutability
and cleanup checks. Existing normal/fallback and before-headers-only manifests
remain valid without requesting the new scenario.

## Acceptance and evidence

Each execution creates `verifications/<run-UUID>/` with its own diagnostics.
`verification-latest.json` belongs to the most recently registered attempt and
changes atomically from `running` to `passed` or `failed`. Registration and
the ownership check/replacement use the same SQLite transaction lock. An older
attempt finishing later keeps its own reports without replacing the marker.
The `.verification-lock.sqlite` pathname must remain in place while attempts
may run; SQLite releases the lock on connection close or process death.
Lock acquisition waits for the current owner without a timeout or lease
stealing. The verifier has per-command deadlines, but no overall run deadline;
a live stalled lock owner can therefore delay publication until it exits.
Only a successful attempt writes its own `verification.json`, after
all cleanup and input-integrity checks. `result.json` also records failures and
the original error separately from cleanup errors. Older successes remain in
identified history; a legacy root `verification.json` is archived before a rerun.
A killed verifier may leave `running`, which must never be interpreted as success.

Capture inputs live in `captures/`. To inspect them again without new traffic:

```sh
REA_MITMDUMP_COMMAND=/absolute/lab/tools/mitmdump \
npm run verify:web:http3 -- /absolute/evidence/run-1 --inspect-existing
```

Acceptance for the current run:

- Every positive native record reports HTTP/3, UDP, ALPN h3 and successful TLS
  timestamps on both legs. Connection IDs, producer TLS labels, exact TLS setup
  timestamps and connection errors match the UUID-matched producer observation
  on each leg. Endpoint handshakes independently observe QUIC v1.
- Native flow UUIDs remain distinct. Three endpoint streams share a connection
  on each leg. Origin dispatch reverses completed receipt. Client and capture
  ordering is observed, while association is verified independent of their order.
- CLI and MCP agree. Request/response bytes, lengths, SHA-256, ordered duplicate
  headers, method, scheme, authority and path match independent observations.
  Readable header names and values, request URL fields and ALPN also match;
  non-UTF-8 header bytes retain a null display value rather than replacement text.
- Actual MCP advertised schemas validate, Evidence preserves source digests and
  provider provenance, and the complete returned Evidence matches the retained MCP session records.
- The fallback capture reports client HTTP/2 over TCP and origin HTTP/1.1, with
  cURL independently reporting version 2. Input files remain unchanged.
- Every cleanup action is attempted on success and failure, and final lineage
  contains no live descendants. Recorded producer groups are inspected separately
  after token-verified cleanup, including after their launcher has exited.

Retain captures, endpoint/producer JSONL, proxy diagnostics, cURL output, manifest,
CLI/MCP output, advertised schema and session bundle. Export public certificates
and dependency/source provenance separately. Do not commit evidence, private
keys, dependencies or VM disks. Shut down the guest after exporting evidence.

The reverse proxy can preserve authority `lab.test:18443` while recording origin
port 19443. Mitmproxy's serialized flow/connection UUIDs are not stream IDs.
Endpoint stream IDs are scoped observations; this test invents no cross-leg
mapping. Mitmproxy 12.2.3's `QUICv1` label alone does not prove negotiation: the
fixture checks the negotiated `_quic._version` in pinned aioquic 1.2.0.

Coverage is native capture, Linux reverse mode, QUIC v1 and these clients.
Client cancellations, other reset codes, certificate failures, malformed
captures, HAR and qlog are separate increments. The optional partial-response
profile verifies absent stored response bytes for one interrupted streamed
response; other empty/incomplete/redacted body semantics remain unverified.
Local/WireGuard, browsers, QUIC v2, migration, 0-RTT, mTLS, replay, sustained load
and loss tolerance remain unverified by this profile. Passing it does not
establish general HTTP/3 support in REA.

Official references: [mitmproxy protocol support](https://github.com/mitmproxy/mitmproxy/blob/v12.2.3/docs/src/content/concepts/protocols.md),
[HTTP/3 implementation](https://github.com/mitmproxy/mitmproxy/blob/v12.2.3/mitmproxy/proxy/layers/http/_http3.py),
[serialized HTTP state](https://github.com/mitmproxy/mitmproxy/blob/v12.2.3/mitmproxy/http.py),
[aioquic configuration](https://github.com/aiortc/aioquic/blob/1.2.0/src/aioquic/quic/configuration.py).

## Verified reset snapshot (2026-10-17)

Executed on Linux x86_64 with Node 24.18.0, npm 11.16.0, Python 3.14.7,
aioquic 1.2.0 and standalone mitmproxy 12.2.3. cURL was 8.22.0 with OpenSSL
3.6.4, ngtcp2 1.25.0 and nghttp3 1.18.0. These reset runs used private
user/mount/network/PID namespaces with loopback, no default routes and a private
`/etc/hosts` bind for `lab.test`. They shared the host kernel/filesystem; the
new reset scenarios were not rerun in the pinned VM image above.

The compiled runtime sources and lockfile match upstream `69324b0f86cc9a209905831b12a18d43afe3657d`.
The following source hashes pin the modified laboratory independently of this
document's text. Their sorted `path + NUL + sha256 + LF` table has SHA-256
`29cc2ecbfd6a20257976b27967b457272d95b87d58dfca4c973e0c5255225e6e`.

| Source                                        | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `scripts/fixtures/http3-lab.py`               | `7f82c7f7a95525577cf0f9c2151fa9e521921902b667ecc80b574766f06aab1c` |
| `scripts/fixtures/observe-mitmproxy-http3.py` | `f6b0f1e488edf7be10266a8ff8ba6ac43b65c09a39a2d0277803c706af2dfa1a` |
| `scripts/lib/http3-capture-assertions.mjs`    | `83c8688a0129691ab1cbc9f2bbfb38b15f28b7ba5db0a1394d7e4a2350b158e0` |
| `scripts/lib/http3-reset-assertions.mjs`      | `a4e9ea369e74c73d3f884f708c23cfb9b2351862c9f64bdae435e76fb43497a1` |
| `scripts/verify-http3-network-captures.mjs`   | `c73c05f610a149b1f203e5c794fa5dd44d44377f8094efc657dfb1296ed99f38` |

Fresh traffic ran through `node scripts/verify-http3-network-captures.mjs
<new-evidence-root> --with-origin-reset --with-partial-reset`. Successful run
`b8f0770e-f8ec-41bc-ae9d-1a15de0a9900` verified nine native records: four normal HTTP/3, two
before-headers reset/recovery, two partial-reset/recovery and one fallback.
CLI/MCP normalized results, advertised schemas, retained Evidence, input digests
and cleanup all passed. Reinspection run
`3b4530b2-39bb-407d-8380-108b29dbd48a` also passed. Reinspection uses the same root with
`--inspect-existing --with-origin-reset --with-partial-reset`.

After rebasing onto upstream `1accac27c36d98fb432e32a4a45fe75c78480773`,
the runtime built at `71942b2617770fd57e2c5e6bb9c3ecbd3348fe82` reinspected
the same nine native records in run `a3a1c38e-d4cf-4cef-97cb-c76743866c40`,
finished 2026-10-18 01:31 UTC. The Node/mitmproxy profile, namespace isolation,
five laboratory source hashes and four capture digests above were unchanged.
CLI/MCP schemas, bytes, identity, retained Evidence and reset/recovery checks
passed again, with no cleanup failures. This reinspection establishes
compatibility with the updated runtime; it generated no new traffic and adds
no scenario or platform coverage.

| Observation             | Result                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before-headers reset    | Endpoint `H3_REQUEST_CANCELLED` (268); producer and REA response null.                                                                                      |
| Partial response        | Status 200, declared 32 bytes; client received the exact 21-byte prefix before reset.                                                                       |
| Stored partial body     | Producer and REA content null, completion timestamp null, no content binary descriptor.                                                                     |
| Recovery                | 42 bytes after the headerless reset; 50 bytes after the partial reset, on each leg's original connection.                                                   |
| Failure/cleanup control | Suppressing the receipt signal caused a failed attempt (`ConnectionTerminated`), no success file, no cleanup failures and no live owned descendants/groups. |

The failure control replaced the receipt event only in a private experiment
driver; it is a controlled verifier fault, not a reproduced aioquic or mitmproxy
bug. Raw captures, endpoint logs, certificates, keys and diagnostics remain
private. Capture digests anchor the observed inputs; fresh runs generate new
UUIDs/timestamps and are not expected to reproduce these file hashes.

| Capture              | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `fallback.mitm`      | `2ee81970e4c39a263646ecba7c100d12e9624820525969e96e259254c5396039` |
| `normal.mitm`        | `8d2b63e40b4997c7333ad33ed11430cffccb9445c071767742f4ffa4a85d0fd6` |
| `origin-reset.mitm`  | `1ba5a3f1ab73da65588a77ca0b576503ab81dffa8d4b26791dd6490abb7ccad7` |
| `partial-reset.mitm` | `bf0e0a15c6f09347dcb1c4372311d71cba5bbe0f3d93e634ffa90b36f918ed50` |

This establishes only the selected Linux reverse-proxy/QUIC v1 profiles.
Buffered partial responses, storing streamed bodies, client cancellations,
other reset codes, real browsers, QUIC v2 and performance costs remain
unverified. Recorded endpoint streams and native connection UUIDs do not
establish a cross-leg stream mapping.

## Verifier regressions

The deterministic capture assertions run in ordinary source CI through
`tests/evaluation/http3CaptureAssertions.test.ts`. That gate runs the pinned
Node test runner, requires a named assertion and successful non-skipped totals,
and rejects an empty test file as well as failing assertions. Run it locally:

```sh
npm run test:focused -- tests/evaluation/http3CaptureAssertions.test.ts
```

After building REA, run the additional lifecycle and Python regressions inside
the same isolated guest:

```sh
node --test scripts/lib/http3-verifier-lifecycle.test.mjs scripts/lib/http3-capture-assertions.test.mjs
/absolute/lab/venv/bin/python scripts/fixtures/http3-lab.test.py
```

These cover different QUIC stream completion orders, stale success reports,
multiple failed closes, separately owned process groups and partially acquired
resources, plus producer TLS fact mismatches on both legs and altered readable
fields with unchanged binary evidence. Reset checks reject invented responses,
incorrect stream/connection attribution, producer case mismatches, missing clocks,
reversed event order and false recovery. Partial-response
checks reject missing or altered receipt, premature completion, fabricated
body storage and mismatched lengths; the Python regression verifies the
acknowledgment barrier before resetting and cleanup while that barrier is still
pending. Client receipt selection uses the caller's requested case for that
stream; response headers remain exact evidence and cannot select another
scenario. Endpoint checks retain the single producer's monotonic event order;
this does not infer timing causality between independent captures. These regressions test verifier
semantics; real-provider coverage comes from the laboratory executions.
