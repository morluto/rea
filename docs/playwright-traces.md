# Offline Playwright traces

Use `inspect_playwright_trace` or `inspect-playwright-trace` with an existing
local Playwright **trace v10** ZIP. Import is offline: recorded URLs are not
requested, and no browser, application or trace viewer is started.

```sh
rea inspect-playwright-trace /absolute/trace.zip --json
rea inspect-playwright-trace /absolute/trace.zip --detail summary \
  --evidence_output /absolute/new-evidence.bundle.json --json
```

MCP defaults to a compact summary and retains complete supported Evidence.
CLI defaults to complete delivery; summary and selected pages require an absent
`--evidence_output` destination, so later queries can read the original parent.

```json
{
  "name": "inspect_playwright_trace",
  "arguments": {
    "path": "/captures/trace.zip",
    "view": {
      "kind": "playwright-trace",
      "collection": "events",
      "kinds": ["network"],
      "fields": ["method", "url", "status"],
      "limit": 10
    }
  }
}
```

`view` takes precedence over `detail`. The retained parent can be queried with
`inspect_analysis_view`; CLI can use the same request against an exported
Evidence bundle with `inspect-analysis-view`.

## Facts, selection and text

The `playwright-trace` view offers:

| Collection    | Available selection                                                    |
| ------------- | ---------------------------------------------------------------------- |
| `events`      | Batch event/stream/call IDs, event kinds, fields, row offset and limit |
| `streams`     | Batch stream IDs, fields and row pages                                 |
| `members`     | Batch member IDs, exact archive paths, fields and row pages            |
| `diagnostics` | Codes, fields and row pages                                            |
| `event-text`  | One event ID, UTF-16 character offset and limit                        |

An omitted filter selects all retained rows; an explicit empty filter selects
none. Minimal event rows keep event/stream IDs, source member/line, producer
ordinal, kind and credential-redaction status. Page exhaustion describes only
the selected facts and never establishes complete recording coverage.

Default event pages return at most 256 UTF-16 code units in `text_preview`,
with explicit text coverage. Continue from that preview's `next_offset` using
`collection: "event-text"`, its `event_id`, `offset`, and a character `limit`
(default 2,048). Character offsets do not split surrogate pairs. Explicit
`fields: ["text"]` returns the complete interpreted text value; `reported`
returns the retained supported payload and sidecars remain selectable.
Complete Evidence remains accessible through ordinary bundle operations.

## Source and coverage

Archive SHA-256 and directory occurrence bind stable member identity. Each event
retains its member ID, physical one-based NDJSON line and zero-based physical
line ordinal. Headline times retain producer monotonic milliseconds, without
aligning stream clocks. Counts derive from the retained supported records. Call IDs are producer values; they do not establish unique actions
across streams or imply a successfully completed before/after pair. There is no
inferred total ordering or clock alignment between `.trace` and `.network`.

Member `path` preserves the reader's original ZIP name; `logical_path` separately
records its normalized interpretation. Resource references, exact `paths` filters
and trace/network profile pairing use original names, so `resources/x` and
`./resources/x` remain distinct. Reader limitations remain attached to each member
and keep source interpretation partial when present.

`decoder_profile` names the selected interpretation policy, not a verified source version.
Trace members require an initial numeric v10 context header. Other declared
versions are refused. Missing, malformed, repeated or ambiguous profiles remain
unknown; network members require one unambiguous paired trace profile. Valid
siblings of malformed records stay useful, with explicit diagnostics. Unsafe
numeric values are not rounded: exact literals stay in sidecars.

Interpreted facts cover action boundaries (class/method, title, call/page IDs,
selected navigation URL/selector, recorded times and available error text),
console text/location, network metadata and screencast references. Other action
arguments, results, context options, DOM, stacks, unsupported event types and
resource contents are outside this version's interpretation. These omissions
are scope limitations, not assertions that omitted values are secrets or absent.
Original archive bytes remain the complete raw source.

Known HAR transport credentials and structured network, navigation and console-location
URL userinfo are excluded using the existing capture projection. Ordinary names, query values, console text and caller data
are preserved. Network numeric/redaction pointers are relative to `reported`;
combine them with the event source's `record_pointer` (`/snapshot`) to locate the
original NDJSON value. Resource-reference pointers already address the physical
record.

Resource references distinguish `present-unread`, `missing`, `ambiguous` and
`unavailable`. Presence means directory metadata only: screenshots and bodies are
not read or validated. Member `declared_bytes` and `declared_compressed_bytes`
come from the ZIP directory; they are not measurements of unread payloads.
Only decoded stream members have verified ZIP CRC and
size. Duplicate names keep separate occurrence IDs; no filename silently picks
a resource. Recording completeness always remains unknown, including after all
retained pages have been read.

## Bounds and verification

Each decoder admits one archive import at a time; concurrent imports receive a
retryable capacity error. Retained queries do not require another import.
Resource policies admit a 256-MiB archive, 32 MiB of decoded streams, a
conservative 32-MiB retained-facts representation, 4-MiB metadata reads and
4-MiB physical lines. JSON parsing additionally checks heap headroom, a
131,072-node record allowance and the shared 64-level capture nesting budget.
These are resource policies, not Playwright format limits. Paging or field
selection does not increase parsing allowances; choose a smaller complete
recorder chunk when admission fails.

The owned fixtures in `tests/fixtures/playwright-trace/` preserve actual
Playwright 1.64.1 v10 recorder text. Public CLI/MCP tests exercise advertised
schemas, retained and bundle queries without the source file, partial facts,
credential exclusion, bounded Unicode previews, and a loopback listener that
must receive no import-time requests. Recorder/version/platform compatibility
outside this verified profile is unverified.
