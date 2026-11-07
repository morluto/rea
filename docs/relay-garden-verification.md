# Relay garden movement verification

Recorded on 16 October 2026 against example commit
`b0627c520c61df13ae81ac08f42fbc197edfdccf`. This record supports the
[movement walkthrough](relay-garden-movement.md) and contributes a bounded
JavaScript example toward [#778](https://github.com/morluto/rea/issues/778).

## Target and environment

- Source: [TheDesignFounder/dreamlayer-game-assets](https://github.com/TheDesignFounder/dreamlayer-game-assets/tree/b0627c520c61df13ae81ac08f42fbc197edfdccf), MIT.
- Input: `reference/artifact/`, two files totaling 1,316 bytes. The editable
  reference source is outside the analysis directory.
- `game.min.js` SHA-256:
  `d454ffb5bd82c40d69f414b2520d3752b1f0911abd12f176c3216ff99017b7a1`.
- REA directory root digest:
  `ea23f8881bba3ea0ca0fb96b2eb36a7dd26252a43b3cf2beae3f744d942fb251`.
- macOS 13.1, x86_64; Node.js 22.23.3; installed `rea-agents` 6.5.0.
- Browser rerun: Google Chrome 155.0.8059.82, Playwright 1.61.0.
- SDK client: `@modelcontextprotocol/sdk` 1.32.1, local stdio transport.
  The server initialized as `rea` 6.5.0.
- Codex directed the calls below through a local SDK bridge, inspected the
  responses, and selected follow-up arguments. This was a guided repeat of the
  published investigation, not a blind discovery or a test of native Codex MCP
  registration. The earlier implementation authored the target.

No provider installation, application execution, account authentication or image
generation was needed for the static investigation. Dependency installation used
the example's committed lockfile. The tests separately execute the self-authored
artifact and game code.

## Recorded MCP exchanges

The following are selected request/response fields from one actual server
connection. Display paths are replaced with `<checkout>`; response fields are
omitted for readability. This is a transcript excerpt, not an authenticated or
importable Evidence bundle. Evidence IDs are copied exactly, and local raw
records were retained for review. Repeating the run can change path-bound IDs.

### 1. Locate the movement function

At 16:47:56 UTC, `analyze_javascript_application` completed with:

```json
{
  "input_path": "<checkout>/reference/artifact",
  "detail": "complete"
}
```

Analysis Evidence ID:
`ev_dfd82a47c3b3125ea6d3c05048da8e0076e1ab1116281c6b52934f9c60be576b`.

The property-read node has `properties.property_path: ["hypot"]` and source
range line 1, columns 24–34. Its `function_node_id` is
`jsrg_node_ca13313a571f6f7fecec9eced9fe300fbd45ebf6384bcbc4b02ec05fafa5f013`.
The referenced function has label `i` and range line 1, columns 0–188.

The semantic graph's aggregate coverage status is `unknown`; its call-flow family
is `partial`. These source locations do not establish complete analysis.

### 2. Check a missing literal match

At 16:49:55 UTC, `trace_javascript_semantics` completed with:

```json
{
  "application": {
    "kind": "retained-evidence",
    "evidence_id": "ev_dfd82a47c3b3125ea6d3c05048da8e0076e1ab1116281c6b52934f9c60be576b"
  },
  "query": {
    "seed": { "kind": "literal", "value": 180 },
    "direction": "callers"
  }
}
```

Returned Evidence ID:
`ev_26e229c01554d0f978838e258606992b71339d218085312801dcc4b9d8aa8a51`.
The result had `status: "partial"`, `coverage.status: "partial"`, no seed matches
and no traversed nodes. The constant appears in the actual function bytes; this
empty trace cannot establish absence. It provides a concrete control for the
walkthrough's uncertainty discussion.

### 3. Trace the function's caller

At 16:50:25 UTC, `trace_javascript_semantics` completed with the same retained
analysis reference and this query:

```json
{
  "seed": {
    "kind": "semantic-node",
    "node_id": "jsrg_node_ca13313a571f6f7fecec9eced9fe300fbd45ebf6384bcbc4b02ec05fafa5f013"
  },
  "direction": "callers"
}
```

Returned Evidence ID:
`ev_998b8d0bf8d788eee7bdf8d008471649f8fee48c0bd51ea5d01e4bfdb9ccdb16`.

Selected `normalized_result` fields:

```json
{
  "status": "found",
  "coverage": { "status": "partial" },
  "summary": {
    "total_seed_matches": 1,
    "traversed_nodes": 2,
    "traversed_relations": 1,
    "traversed_functions": 2,
    "traversed_modules": 1,
    "relevant_unknowns": 8
  }
}
```

The call-site range is line 1, columns 232–363. Its relation is a conservative
static candidate, not proof that the call ran. All eight returned unknowns have
reason `dynamic-call`. The numeric movement rule is the agent's interpretation
of the selected artifact bytes, checked by the executable comparisons below.

At 16:51:14 UTC the client closed the connection. The owned server process had
exited when checked. No native engine or target runtime was launched by these
analysis calls. No persistent client configuration was changed.

## CLI and executable checks

From a fresh checkout with locked dependencies:

| Command                   | Observed result                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                  | 208 packages installed; completed successfully                                                                          |
| `npm run investigate`     | Analysis and callers trace completed; two nodes, one relation, eight relevant unknowns                                  |
| `npm test`                | Eight tests passed, including 2,000 deterministic artifact/reconstruction comparisons and explicit input/boundary cases |
| `npm run validate:assets` | Ten digests checked; seven runtime images, six transparent sprites and three recorded completed generation operations   |

The investigation script checks the minified file digest before analysis. Complete
CLI records and its generated trace request occupy 1,066,741 logical bytes under
`.local/` in this run. The generated public excerpt is not an importable record.
The asset check validates existing files and generation records; it submits no
new image request.

The existing browser suite was run against a separate loopback server using
`DEMO_URL=http://127.0.0.1:4191/demo/ BROWSER_CHANNEL=chrome npm run test:browser`.
The first attempt failed its player-position assertion after 500 ms of virtual
time. An unchanged rerun passed all six reported groups, covering keyboard movement and
pause, exact state preservation across visual modes, asset decoding/transparency
and drawing, a complete six-cell playthrough, replay and pointer release, reduced
motion, and 320/390 px layouts.

Follow-up checks on the same day reproduced a timing problem in the test: the
game could advance while the controller waited between key input and an explicit
clock step. A separate local fix pauses the test clock before starting the game.
All seven checks in the amended browser suite passed, including a new check that
the game stays still between clock steps. Removing only the pause made that new
check fail. An independent review repeated both results on Chrome 155.0.8059.82.

The fix is local commit `4675191553374770103bcd4a355c4f80c594db2e` in the game
repository and changes only `scripts/browser-check.mjs`. It is not part of this
REA documentation change or the public example pinned at `b0627c5`. The original
failure did not capture enough timing data to prove its exact cause; the later
experiment establishes a reproducible timing problem and a check for its return.

The minified function occupies columns 0–188 of line 1. The walkthrough's exact
excerpt is compared byte-for-byte with that slice. The project's tests compare
the exported artifact function with the separately written implementation using
a tolerance of `1e-10` for the deterministic cases. This is finite testing, not
a proof for every JavaScript input.

## Measurements and limits

| Measurement                         | Observed value and scope                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| CLI analysis                        | 60.682 seconds, including process startup                                                                      |
| CLI callers trace                   | 18.492 seconds, including process startup                                                                      |
| Whole `npm run investigate` command | 81.88 seconds wall time; 31.60 seconds user CPU; 9.44 seconds system CPU, reported by macOS `/usr/bin/time -l` |
| Reported maximum resident set size  | 247,906,304 bytes from `/usr/bin/time -l`; not a sampled sum of simultaneous process-family memory             |
| MCP analysis call                   | 34.973 seconds on an already initialized connection                                                            |
| MCP literal control                 | 0.235 seconds                                                                                                  |
| MCP callers trace                   | 0.131 seconds                                                                                                  |
| New generation spend                | Zero; bundled artwork reused                                                                                   |

These are single observations on a shared workstation. CLI process startup and
MCP initialization differ, so these values are not a performance comparison.
Agent reading/decision time is excluded from per-call measurements. Model token
cost, MCP process-family CPU/peak memory, cold package-download time and peak
temporary working space were not measured. The target size and retained output
size above are logical byte counts, not peak disk usage.

[The 30-second gameplay video](https://github.com/user-attachments/assets/155db219-8f74-47af-9079-94cac8a6d77e)
demonstrates the final game. A separate
[86-second investigation recording](https://github.com/user-attachments/assets/6a79bb7e-a246-4a77-b272-339116e5dd93)
shows a guided repeat of the MCP workflow with real calls and test results. Its
[transcript](https://github.com/TheDesignFounder/dreamlayer-game-assets/releases/download/relay-garden-videos-20261016/rea-investigation-transcript.md)
records that repeat. The closing promotional note is omitted; tool output and
timing are unchanged. The request excerpts and timings above describe the earlier
verification run, rather than the later recorded repeat. No Unity, Godot, native-engine, other agent-host or production-service
support claim follows from this example. This contribution leaves the broader
starter portfolio and its recording requirements in #778 open.
