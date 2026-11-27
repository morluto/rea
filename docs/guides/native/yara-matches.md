# YARA rule matches

`inspect_yara_matches` / `inspect-yara-matches` scans one selected local file
with YARA rule files that the caller supplies, using the `yara` command
installed on the host. It reports the matching rules with their tags,
metadata, and string match offsets, bound to the SHA-256 of the scanned file
and of each rule file. The file is read, never executed. REA ships no rules,
installs nothing, and downloads nothing.

```bash
rea inspect-yara-matches /absolute/path/to/sample.bin \
  --rule_paths /absolute/path/to/packers.yar --json
```

Repeat `--rule_paths` to compile several rule files together, in the order
given. The CLI resolves relative paths against the caller's working directory.
MCP requires absolute paths and preserves the exact selection. There is no
artifact-id input: to scan a file pulled out of an archive or bundle, pass the
path of the extracted file.

```json
{
  "name": "inspect_yara_matches",
  "arguments": {
    "path": "/artifacts/sample.bin",
    "rule_paths": ["/rules/packers.yar", "/rules/crypto.yar"]
  }
}
```

## Setup

Install YARA 4.x from your package manager or the
[YARA releases](https://github.com/VirusTotal/yara/releases), then either put
`yara` on `PATH` or set `REA_YARA_COMMAND` to the executable. REA runs that
command and does not verify its implementation or version; the Evidence
records it as `yara.command` with no version.

When the command cannot be found or started, the call fails with
`capability_unavailable` and the remediation names `REA_YARA_COMMAND`. Other
tools are unaffected.

## How the scan runs

REA streams each rule file and the scanned file into an owned private temporary
snapshot directory while computing each file's SHA-256 digest and verifying that
the source file did not change during acquisition. Relative `include "..."`
directives in staged rule files are resolved against each selected rule file's
directory so existing rule sets with relative includes continue to compile. It
then runs:

```text
yara -s -L -m -g -q [-f] rea:<snapshot_rule_path>... <snapshot_target_path>
```

The command is started directly with an argument list, never through a shell,
with its working directory at the root of the snapshot's filesystem. `-f` is
added when `fast_scan` is true. The child runs with `LC_ALL=C` and `LANG=C`.
Each rule argument carries a `rea:` namespace prefix so yara never splits a path
containing `:` into `NAMESPACE:FILE`. Match output names rules without the
namespace, and REA maps compile diagnostics and warnings back to the caller's
selected paths. Paths that contain a line break are refused, because yara's
output is line oriented.

Because yara reads only the owned snapshot files bound to the computed SHA-256
digests, concurrent renames or replacements of the caller's files or parent
directories after acquisition cannot attribute matches from different bytes to
the reported digests. Before reporting, REA verifies that none of the snapshot
files changed during the scan (failing with `artifact_changed` if one did) and
removes the snapshot directory. Cleanup that cannot be proven is retained and
retried before the next scan and on close.

YARA output is parsed as it streams. Rule lines must name the scanned path, and
every string line must follow a rule line; anything else fails with a provider
output error instead of a partial result.

## Observations

`artifact` gives the scanned path, SHA-256, and byte length. `rule_files` gives
the same for each rule file, in the order passed to yara.

Each entry in `matches` has:

- `rule`: the rule identifier.
- `tags`: the rule's tags in declaration order.
- `meta`: each metadata entry with its `identifier`, `type` (`string`,
  `integer`, `boolean`, or `bytes`), and `value`. A string value that is not
  valid UTF-8 is reported as `bytes` with lowercase hex. An integer outside the
  safe JSON range is reported as decimal text.
- `string_match_count`: every string match yara reported for the rule.
- `strings`: the listed string matches, each with `identifier`, `file_offset`,
  `length`, and `data`. `data` is yara's display text: printable ASCII with
  `\xNN` escapes for text and regex strings, and spaced hex for hex strings.
  YARA may shorten long matches, so read `length` bytes at `file_offset` from
  the artifact for the exact bytes.

Rules that did not match are absent. `warnings` holds the warning lines yara
printed, such as slow-string warnings, verbatim, followed by any other stderr
line that matches none of yara's documented diagnostic forms.

## Limits

| Control              | Setting                   | Launch seed                   | Default  | Range              |
| -------------------- | ------------------------- | ----------------------------- | -------- | ------------------ |
| `command_timeout_ms` | `yara.command_timeout_ms` | `REA_YARA_COMMAND_TIMEOUT_MS` | 60000    | 1 to 2147483647    |
| `max_output_bytes`   | `yara.max_output_bytes`   | `REA_YARA_MAX_OUTPUT_BYTES`   | 67108864 | 4096 to 1073741824 |
| `max_matches`        | `yara.max_matches`        | `REA_YARA_MAX_MATCHES`        | 256      | 1 to 100000        |
| `max_file_bytes`     | none (per call only)      | none                          | 2 GiB    | 1 byte to 64 GiB   |

A call argument wins over a runtime override from `update_analysis_settings`,
which wins over the launch seed, which wins over the default. `limits` in the
result reports each value and its source. An invalid launch seed is refused
rather than replaced by the default.

- `command_timeout_ms` bounds the yara process. When it elapses, REA stops the
  process group and the call fails with a timeout that names the setting.
- `max_output_bytes` bounds the stdout REA parses and the stderr it keeps.
  Output beyond it stops the scan with a resource error that names the
  setting.
- `max_matches` bounds the string matches listed across all rules. Later
  matches are still counted in `string_match_count` and `coverage`, so
  `coverage.status` is `partial` and a limitation states how many are unlisted.
  Raise `max_matches` to list them.
- `max_file_bytes` bounds the scanned file and each rule file.
- At most 64 rule files can be passed in one call.

`fast_scan` passes `--fast-scan`, which stops at the first match of each
string; string match counts are then lower bounds.

## Errors

- A rule file that yara cannot compile fails with `invalid_request`. Each issue
  names the rule file (`rule_paths[i]` when it is one of the selected files, or
  `rule_paths` for an included file), the line, the rule when yara named one,
  and yara's message. `diagnostics.compile_errors` records each error with a
  `kind` read from yara 4.x's message text: `include` (an include file cannot
  be opened, a circular include, or too many include levels), `syntax`,
  `undefined` (an undefined identifier or string, or an unknown module),
  `duplicate` (a duplicated rule, string, tag, or metadata identifier),
  `unreadable_file`, or `other`. When a file name or message itself contains
  `(N): ` and yara's text cannot be split into one file and line, `source` and
  `line` are `null` and `message` keeps the whole text. The remediation gives
  one repair per kind present. Rules that need external variables (`-d`) or module data cannot be
  compiled by this tool. Stderr lines that match no documented form are kept
  in `diagnostics.unrecognized_stderr_lines`.
- A missing or unreadable rule file is refused before yara starts.
- Cancellation stops the yara process group before the call returns. Cleanup
  that cannot be proven is retained and retried before the next scan.

## What the Evidence does not establish

- Which yara implementation or version ran.
- The contents of files that a rule file `include`s, or module data yara read;
  only the selected rule files are hashed.
- Why a rule did not match.
