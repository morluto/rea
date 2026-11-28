# Findings triage experiment

This is a small, unregistered prototype. **Maintainer scope decision: pending**
under [CONTRIBUTING.md](../../CONTRIBUTING.md#fail-closed-integration).

It turns a finished REA investigation into a triage report. The inputs are an
Evidence bundle written by `export_evidence_bundle` and a `triage.json` written
by the analyst. The output classifies every finding as `defect`, `suspect`,
`acceptable` or `unknown`, with remediation and a next probe, and drafts GitHub
issue bodies and private advisories. The analyst judges; the validator refuses
any verdict that the cited Evidence cannot support.

It does not find defects, execute targets or create issues. It makes no network
calls and registers nothing in `src/`, the CLI, the MCP catalog or the package.
It reads two local files and writes one new directory.

[#1142](https://github.com/morluto/rea/issues/1142) proposes
[TraceBrief](https://github.com/dany331x/tracebrief) (MIT), which renders
evidence-gated Markdown reports from bundles. TraceBrief has no verdicts,
remediation, next probes or issue export; this experiment tests those
additions. It reuses TraceBrief's vocabulary (`claim_type`, issue objects with a code and
JSON path, exit codes 0/1/2) but none of its code.

## Run

Use the pinned toolchain and build the runtime first; the experiment imports
REA's bundle parser and digest schemas from `dist/`.

```sh
nvm use
npm ci
npm run build:cached
node --test experiments/findings-triage/*.test.mjs
node experiments/findings-triage/cli.mjs validate \
  --triage experiments/findings-triage/fixture/triage.json \
  --bundle experiments/findings-triage/fixture/bundle.ndjson [--json]
node experiments/findings-triage/cli.mjs render \
  --triage experiments/findings-triage/fixture/triage.json \
  --bundle experiments/findings-triage/fixture/bundle.ndjson \
  --out /path/to/new-directory
```

| Exit | Meaning                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| 0    | No issues.                                                                                                                |
| 1    | Validation issues. `render` writes nothing.                                                                               |
| 2    | Usage error, unreadable file, malformed JSON, a bundle REA's parser rejects, an existing `--out` path, or a failed write. |

`validate --json` prints the issue array, `[{ code, path, message }]`, where
`path` is a dotted path into `triage.json`. Any issue blocks rendering.

The bundle is parsed with `parseEvidenceBundle`, which also authenticates every
Evidence ID and residual-unknown revision. An edited or non-canonical bundle
exits 2 with REA's own failure description.

## `triage.json`

The document is strict: unknown keys are rejected, and all schema problems are
reported together. Rule checks run once the shape is valid.

```json
{
  "schema": "findings-triage/1",
  "title": "triage-notes static triage",
  "target": { "name": "triage-notes", "artifact_digest": "771d6f…" },
  "findings": [
    {
      "id": "notes-save-unchecked-path",
      "title": "notes:save writes to a path chosen by the renderer",
      "statement": "…",
      "verdict": "defect",
      "claim_type": "structure",
      "evidence_ids": ["ev_3607d6…"],
      "severity": "high",
      "disclosure": "private",
      "impact": "…",
      "remediation": "…"
    }
  ]
}
```

- `target.artifact_digest` is a SHA-256 hex digest or `null`.
- `title` (document and finding) is one line without control characters; a
  finding title becomes an issue title.
- `id` matches the ASCII pattern `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and is not
  a Windows device name such as `CON` or `nul`, because it becomes a file name.
  IDs must also be unique without regard to case.
- `claim_type` is `structure`, `behavior` or `runtime-behavior`.
- `evidence_ids` uses REA's `ev_<64 hex>` form without repeats; optional
  `unknown_id` uses `unk_<64 hex>`.
- Optional fields: `severity` (`low` to `critical`), `disclosure` (`public` or
  `private`), `impact`, `remediation`, and
  `next_probe: { operation, rationale }`.

| Verdict      | Also requires                                     |
| ------------ | ------------------------------------------------- |
| `defect`     | `severity`, `disclosure`, `impact`, `remediation` |
| `suspect`    | `severity`, `disclosure`, `impact`, `next_probe`  |
| `unknown`    | `next_probe`                                      |
| `acceptable` | nothing                                           |

Evidence strength is never authored. The report computes the strongest cited
confidence and the set of cited authorities.

## Rules

The current state of a residual unknown is its highest revision, so a bundle can
hold an `open` revision and a later `resolved` revision of the same ID.

Only `defect` and `acceptable` settle a question, so only they need a
qualifying record: one that is `observed` or `derived` and whose authority is
not `analyst-inference`. Residual-unknown mutation records are derived but
record analyst intent, not proof. Inferred-only Evidence supports at most
`suspect`. A runtime record has `controlled-replay` or `external-service`
authority. A `suspect` or `unknown` about runtime behavior is valid without
runtime Evidence; its `next_probe` names how to obtain it.

| Code                                      | Error when                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `schema_violation`                        | The document does not match the format above.                                                 |
| `duplicate_finding_id`                    | Two finding IDs differ only by case.                                                          |
| `evidence_not_in_bundle`                  | A cited Evidence ID is not a bundle record.                                                   |
| `finding_without_evidence`                | A finding other than `unknown` cites nothing.                                                 |
| `verdict_requires_observed_basis`         | A `defect` or `acceptable` finding cites no qualifying record.                                |
| `runtime_claim_without_runtime_authority` | A `runtime-behavior` `defect` or `acceptable` finding cites no qualifying runtime record.     |
| `evidence_subject_mismatch`               | A cited record's subject digest differs from `target.artifact_digest` (both present).         |
| `target_not_in_bundle`                    | `target.artifact_digest` is not in the bundle's artifacts.                                    |
| `unknown_not_in_bundle`                   | A linked `unknown_id` is not in the bundle.                                                   |
| `unknown_resolved`                        | A linked unknown's current revision is `resolved`.                                            |
| `verdict_conflicts_with_open_unknown`     | A `defect` or `acceptable` finding links an unknown whose current revision is not `resolved`. |
| `unknown_not_triaged`                     | A current unknown that is not `resolved` is linked by no finding.                             |
| `<field>_missing`                         | A field the verdict requires is absent.                                                       |

## Outputs

`render --out DIR` creates `DIR` without creating parents, so an existing path
fails and no caller file is overwritten. `DIR` is owner-only (`0700`) because
the report and advisories can hold private findings. Files are written
exclusively. If a write fails, `render` removes the directory it created.

- `report.md`: title, target, the bundle file's SHA-256, record and residual
  unknown counts, verdict counts, then Defects, Suspects, Unknowns and
  Acceptable, each ordered by severity (highest first) and then ID. Each
  finding shows its statement, severity and disclosure, computed strength, an
  Evidence table, impact, remediation and next probe. An Evidence section then
  lists each cited record once with its operation, confidence, authority and
  verbatim limitations. A final table lists the current revision of every
  residual unknown and the findings that triage it.
- `issues/<id>.md`: body for each public `defect` or `suspect`. Bodies are read
  standalone, so they repeat the deduplicated limitations of their cited
  records.
- `advisories/<id>.md`: draft for each private `defect` or `suspect`, starting
  with its title.
- `issues.json`: `[{ id, title, body_file, fingerprint }]` for public items only.

Output is deterministic: no timestamps, and every list has a fixed order.
Bodies contain only triage text, the Evidence table and limitations; they never
copy `raw_result`, `parameters` or `environment`, which can carry local paths.
Each body ends with `<!-- findings-triage:<fingerprint> -->`. The fingerprint
is the first 16 hex digits of SHA-256 over `target.name + "\0" + id`, so a
finding that survives into a new build matches the issue already filed.

## Filing issues

To file public items with `gh` and `jq`, skipping ones already filed, search
existing issues for the marker:

```bash
out=/path/to/render-output
jq -c '.[]' "$out/issues.json" | while read -r item; do
  fingerprint=$(jq -r .fingerprint <<<"$item")
  found=$(gh issue list --state all --search "$fingerprint in:body" \
    --json number --jq length)
  [ "$found" -eq 0 ] || continue
  gh issue create --title "$(jq -r .title <<<"$item")" \
    --body-file "$out/$(jq -r .body_file <<<"$item")"
done
```

GitHub search indexing can lag, so this skips duplicates on later runs but is
not a lock against concurrent runs. Never file `advisories/` as public issues.
Submit each one through the target repository's private vulnerability
reporting (**Security** tab, **Report a vulnerability**) or the channel its
security policy names.

## Fixture

`fixture/app/` is a self-owned, Electron-style notes app that is analyzed
statically and never executed. It has two deliberate problems: the
`notes:save` handler writes to a path chosen by the renderer, and the window
sets `webSecurity: false` and `sandbox: false`. The preload is fine: with
`contextIsolation: true` it exposes two named functions rather than
`ipcRenderer`. The page script is inline in `index.html`.

`fixture/generate.mjs` copies the app into a new temporary directory, starts the
built REA MCP server over stdio, runs `analyze_javascript_application`, records
three residual unknowns, resolves one with `update_unknown`, and exports
`fixture/bundle.ndjson`. It removes the temporary directory and closes the
server on every path. To regenerate:

```sh
npm run build:cached
node experiments/findings-triage/fixture/generate.mjs
```

The file holds REA's exact one-line export. It uses the `.ndjson` extension
because one JSON document on one line is valid NDJSON, which the repository
formatter and lint-staged leave untouched, so the report's bundle digest is
the digest of REA's own bytes.

The temporary path is part of each record's subject, so every run changes the
Evidence IDs; the directory digest stays the same. Update `fixture/triage.json`
from the new bundle, then replace `fixture/expected/` with a fresh `render` into
that path. The bundle's only local path is the temporary
`/tmp/findings-triage-<random>/app`.

`fixture/triage.json` cites only facts in the bundle's
`analyze_javascript_application` record (derived, shipped-artifact):

- `notes-save-unchecked-path` (defect): a main `handle` handler for the
  literal channel `notes:save`; a resolved alias from its `filePath` parameter
  to argument 0 of the call at main.js:21, whose `writeFile` target is a
  candidate; zero sender-validation observations.
- `insecure-web-preferences` (suspect): the only BrowserWindow has literal
  `webSecurity: false` and `sandbox: false`. Whether it loads non-local content
  is the open unknown the finding links.
- `notes-save-page-callers` (unknown): REA reports that the inline script in
  `index.html` was not analyzed, so the page callers of `window.notes.save` are
  unknown.
- `preload-bridge-scope` (acceptable): one contextBridge API, `notes`, an object
  literal with members `load` and `save` and no unknown members;
  `contextIsolation: true` is literal.

The third residual unknown, whether the preload exposes `ipcRenderer`, is
resolved by a verified revision. Linking it from a finding would be
`unknown_resolved`, so the final report table shows it as untriaged and
resolved.

## Verification and limitations

Commands run on Linux x64 with Node 24.21.0:

| Command                                                                     | Result                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `node experiments/findings-triage/fixture/generate.mjs`                     | Exit 0; 5 records and 4 unknown revisions; no temporary directory or server process left. |
| `node --test experiments/findings-triage/*.test.mjs`                        | 36 pass, 0 fail.                                                                          |
| `npx oxlint experiments/findings-triage`                                    | 0 warnings, 0 errors.                                                                     |
| `npx oxfmt --check experiments/findings-triage`                             | All files formatted.                                                                      |
| `npx jscpd experiments/findings-triage`                                     | 0 clones.                                                                                 |
| `cli.mjs render` of the fixture, then `diff -r` against `fixture/expected/` | Identical.                                                                                |

Only the static JavaScript application provider and the residual-unknown
registry were exercised. The bundle has no `controlled-replay` or
`external-service` Evidence, so the runtime rule is tested with records
appended to an in-memory copy of the parsed bundle; `validate` does not
re-authenticate records. macOS and Windows were not run; the Windows
device-name check is a pattern test, not a Windows file system test.

The rules check cited records' metadata (presence, confidence, authority,
subject digest and unknown state). They do not check that a statement says what
its Evidence shows; that remains the analyst's responsibility. The fingerprint
depends on the finding ID, so renaming a finding files it again. No performance
measurements were taken; the experiment adds no REA analysis work beyond the
fixture generator.
