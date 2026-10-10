# JavaScript source recovery

`recover_javascript_sources` / `recover-javascript-sources` derives readable
modules from one explicitly selected UTF-8 JavaScript file or bundle. Use it on
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

```sh
rea recover-javascript-sources /tmp/web-scripts/app.js /tmp/recovered-app --json
rea analyze-javascript-application /tmp/recovered-app/modules --json
```

MCP input:

```json
{
  "path": "/tmp/web-scripts/app.js",
  "output_directory": "/tmp/recovered-app"
}
```

The output directory must be absent, absolute, and have an existing parent.
The source is snapshotted in a private workspace, and the engine writes only to
its own staging directory. Reported module paths, input identities, UTF-8 byte
ranges, regular files and emitted map representations are validated before
publication. REA writes verified bytes to an exclusively owned output tree and
rolls it back on failure. It also checks that the original source and engine
bytes remain unchanged before committing. The existing output is never overwritten.

Published contents:

- `inputs/bundle.js`: exact original snapshot; its digest binds the Evidence.
- `modules/`: derived modules and any upstream-emitted source maps.
- `reports/stdout.json` and `reports/provenance.json`: exact producer reports.
- `manifest.json`: identities, modules, transform choices, warnings and limitations.

The inline result includes complete file paths/digests/sizes, extraction ranges,
warnings and `analysis_input`, directly usable as the arguments to
`analyze_javascript_application`. Raw Evidence retains selected command arguments,
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

Each operation uses one worker, a 1 GiB address-space ceiling and a 120-second
deadline; it accepts up to 64 MiB of input and 128 MiB/10000 entries of staged
output, with 8 MiB per diagnostic/report stream. Exceeding a limit is an explicit
failure with rollback. These limits apply per operation and do not claim aggregate
host containment across concurrent callers.

See [testing.md](testing.md#javascript-source-recovery) for the focused real
Wakaru CLI/MCP lane and its source-owned compiler fixtures. Other host platforms
and Bun/Vue recovery are not claimed by this adapter.
