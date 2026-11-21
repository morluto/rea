# JavaScript source recovery

`recover_javascript_sources` / `recover-javascript-sources` derives readable
modules from explicitly selected UTF-8 JavaScript files or bundles. Use it on
files returned by `export_web_scripts` or other local scripts. The operation
never executes the selected or recovered application code.

## Caller-supplied engine

REA accepts Wakaru **^1.13.0** on Linux x64. The report parser is verified with
Wakaru **1.14.0**. Another release in that range is accepted, the observed
version is reported, and a limitation records that the parser was not verified
against that release. Wakaru changes `--version`, `--json` and `provenance.json`
only by addition within a major version
([compatibility policy](https://github.com/pionxzh/wakaru/blob/v1.14.0/docs/cli.md#machine-readable-output-compatibility)),
so the parser keeps unknown report fields and reported module statuses.

Set `REA_WAKARU_COMMAND` to the absolute path of an executable supplied by the
caller. The adapter uses util-linux `prlimit` (default `/usr/bin/prlimit`;
override with an absolute `REA_JAVASCRIPT_PRLIMIT_COMMAND`). REA does not install
either tool. Engine configuration is checked only when recovery is requested;
other REA capabilities remain available without it.

Unmodified upstream source is retained in `third_party/wakaru`, pinned to
`8219bf5016a063d7fb215101a8c45d5959ec733f` (v1.14.0, Apache-2.0).
The result reports the executed binary's exact path, SHA-256 and observed version.
The audited source revision is distinct from `executed_source_revision: null`:
a version string cannot prove which source produced a caller-supplied binary.

### Install Wakaru

Use the official release binary, the same one CI verifies:

```sh
curl -fL https://github.com/pionxzh/wakaru/releases/download/v1.14.0/wakaru-linux-x64.tar.gz | tar -xz wakaru
export REA_WAKARU_COMMAND="$PWD/wakaru"
```

Or install it from npm. Point at the platform binary, not the Node.js shim in
`node_modules/.bin`:

```sh
npm install wakaru@1.14.0
export REA_WAKARU_COMMAND="$(realpath node_modules/@wakaru/cli-linux-x64/wakaru)"
```

Both give the same binary (SHA-256
`664fa06782a61eda7ed15885134b52525fd565dd77607e642062ceb6cd927c38`).

## Recover and analyze

The integrated `recover_javascript_sources` / `recover-javascript-sources` flow
below is available only on supported hosts (Linux x64 with a configured Wakaru
engine and `prlimit`). For other hosts, see
[Unsupported hosts and manual recovery](#unsupported-hosts-and-manual-recovery-example-windows).

```sh
rea recover-javascript-sources /tmp/web-scripts/app.js /tmp/recovered-app --json
rea analyze-javascript-application /tmp/recovered-app/modules --json

# Recover related code-split chunks together; repeat --additional-path.
rea recover-javascript-sources /tmp/web-scripts/main.js /tmp/recovered-chunks \
  --additional-path /tmp/web-scripts/runtime.js \
  --additional-path /tmp/web-scripts/shared.js \
  --additional-path /tmp/web-scripts/checkout.chunk.js --json
```

MCP input:

```json
{
  "path": "/tmp/web-scripts/main.js",
  "additional_paths": [
    "/tmp/web-scripts/runtime.js",
    "/tmp/web-scripts/shared.js",
    "/tmp/web-scripts/checkout.chunk.js"
  ],
  "output_directory": "/tmp/recovered-chunks"
}
```

The output directory must be absent, absolute, and have an existing parent.
Each source is snapshotted separately in a private workspace. Multiple inputs
retain their relative directory layout and are passed together to one Wakaru
invocation, allowing cross-chunk module IDs to resolve. Inputs must be distinct;
`additional_paths` accepts up to 16 additional files. The engine writes only to
its own staging directory. Reported module paths, input identities, UTF-8 byte
ranges, regular files and emitted map representations are validated before
publication. REA writes verified bytes to an exclusively owned output tree and
rolls it back on failure. It also checks that the original source and engine
bytes remain unchanged before committing. The existing output is never overwritten.

A denied selected-input read reports `access_denied` with the observed OS code
and path. A source or engine identity change reports `artifact_changed`;
neither failure is a malformed recovery request. Cancellation retains the
caller's reason through admission, command launch and completion.

Multi-input relative filenames must be representable unchanged as artifact paths:
NFC Unicode spelling and no literal backslashes. Unsupported layouts fail before
invoking the engine rather than silently renaming inputs referenced by source maps.

Published contents:

- `inputs/bundle.js`: exact original snapshot for a single input. Multiple inputs
  retain paths relative to their common parent under `inputs/`.
- `modules/`: derived modules and any upstream-emitted source maps.
- `reports/stdout.json` and `reports/provenance.json`: exact producer reports.
- `manifest.json`: identities, modules, transform choices, warnings and limitations.

The inline result includes complete file paths/digests/sizes, extraction ranges,
warnings and `analysis_input`, directly usable as the arguments to
`analyze_javascript_application`. `source` identifies the primary input and binds
the Evidence subject; `additional_sources` records the other snapshots and their
published copies when selected. Each module names its owning snapshot, original
path and original digest; all extraction and context ranges refer to that input.
Raw Evidence retains selected command arguments,
reported input paths, exit status, stderr and reports; temporary paths are recorded
as historical execution coordinates after their workspace is removed.

## Transform choices and interpretation

`extraction_mode` defaults to `structural` (Wakaru `--unpack=strict`). `heuristic`
uses `--unpack=auto`; `inspection` uses `--unpack=inspect` and can return finer,
non-executable regions. `rewrite_level` accepts `minimal`, `standard` (default)
and `aggressive`. Maps and provenance are requested in every operation.

Structural extraction can fall back to a single file. In the real fixtures,
webpack 5 yields two modules; the esbuild scope-hoisted fixture remains one
unknown-format script. Returned module counts and detected formats report those
actual outcomes. A valid report with failed transformations returns `partial`
with original warnings and files. An unusable report, inconsistent provenance,
escaping path, symlink or missing module is an error, with owned cleanup.

Evidence confidence is `derived`. Extraction ranges are half-open **UTF-8 byte
offsets in the original snapshot**, rather than rewritten line positions or a
coverage assertion. Source maps are preserved without claiming independently
verified mapping accuracy. Original variable names and arbitrary runtime
equivalence remain unknown. No network fetching occurs.

## Resource policy and verification

Each operation uses one worker, a 1 GiB address-space ceiling and a 120000 ms
deadline. That deadline has no runtime override: raising `analysis_timeout_ms`
or `max_heap_mb` does not raise it. An unchanged retry may hit the deadline
again. The operation accepts up to 64 MiB of total
input across all selected files and 128 MiB/10000 entries of staged output,
with 8 MiB per diagnostic/report stream. A `provenance.json` over that report
allowance names the fixed limit: this release has no runtime override, and
raising `max_heap_mb` or `analysis_timeout_ms` does not raise it. Malformed
reports stay distinct from that size refusal. Exceeding a limit is an explicit
failure with rollback. Selected inputs beyond the total input allowance return a
non-retryable `resource_constraint` with `resource: "file-size"` and
`reported_limits.maximum_input_bytes`/`remaining_input_bytes`; input that is not
valid UTF-8 is an `invalid_format` request issue. These limits apply per
operation and do not claim aggregate host containment across concurrent callers.

See [source recovery verification](../../testing-lanes.md#javascript-source-recovery) for the focused real
Wakaru CLI/MCP lane and its source-owned compiler fixtures. Other host platforms
and Bun/Vue recovery are not claimed by this adapter; for an unsupported-host
workflow, see
[Unsupported hosts and manual recovery](#unsupported-hosts-and-manual-recovery-example-windows).

## Unsupported hosts and manual recovery (example: Windows)

REA's integrated recovery tool is **not available** on unsupported hosts. The
`recover_javascript_sources` / `recover-javascript-sources` adapter currently
requires:

- **Linux x64**
- an absolute `REA_WAKARU_COMMAND` pointing to a caller-supplied Wakaru
  **^1.13.0** executable (verified with 1.14.0)
- util-linux `prlimit` (or an absolute `REA_JAVASCRIPT_PRLIMIT_COMMAND`)

On Windows and other unsupported hosts, you can use an **external/manual**
recovery workflow and still analyze the recovered output with REA:

1. **Recover outside REA.** Run Wakaru (or another recovery process you trust)
   outside REA on the selected local UTF-8 JavaScript files/bundles, including
   related runtime/shared/lazy chunks when they must be recovered together. Use
   the Wakaru version, options, and output layout appropriate for that external
   tool; REA does not install, launch, or constrain that external run.
2. **Prepare a modules directory.** Collect the recovered readable `.js` modules
   (and any emitted source maps, if present) into a directory. When possible,
   align the layout with REA's integrated recovery `modules/` output so the
   analyzed files are easy to identify; if the external tool uses a different
   layout, point analysis at the directory that contains the recovered modules.
3. **Analyze with REA.** Run static analysis on that directory; REA does not
   execute the selected or recovered code:

   ```sh
   rea analyze-javascript-application C:\path\to\recovered\modules --json
   ```

   ```json
   {
     "tool": "analyze_javascript_application",
     "arguments": {
       "input_path": "C:\\path\\to\\recovered\\modules"
     }
   }
   ```

**Differences from integrated `recover_javascript_sources`:** external recovery
does not produce REA's `analysis_input`, `manifest.json`, `reports/*`, or
inline recovery result contract, and it does not provide REA-managed input
snapshots, per-input provenance/extraction-range metadata, validated publication,
or rollback semantics. Treat provenance, tool versions, and input/output
mappings as operator-managed records, and verify on a sample that the external
output layout is suitable for `analyze_javascript_application`. This manual path
does not change the availability or guarantees of the integrated recovery tool.
