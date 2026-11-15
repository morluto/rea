# Verify a web reconstruction

Compare the original and reconstruction through explicit browser actions, then
verify finite claims against their Evidence. Pixel agreement and agreement on
observed behavior are separate claims; neither establishes global equivalence.

## Complete runnable example

Build with the pinned project toolchain, then supply an existing Chromium-compatible
browser and a **new absolute** output directory:

```sh
npm run build:cached
node scripts/examples/web-reconstruction.mjs /absolute/path/to/chromium /absolute/path/to/new-web-example
```

For Windows, for example:

```powershell
node scripts/examples/web-reconstruction.mjs "C:/Program Files/Google/Chrome/Application/chrome.exe" "D:/analysis/new-web-example"
```

The example starts two source-owned pages on different loopback ports, captures
each through the public CLI, compares their Evidence through CLI and stdio MCP,
verifies the same specification through both, and closes its servers and MCP
connection. It installs nothing and contacts no third-party target.

The candidate intentionally looks identical while reporting a different save count:

| Claim             | Result    | Reason                                                |
| ----------------- | --------- | ----------------------------------------------------- |
| `save-appearance` | `pass`    | The selected saved screen has identical pixels.       |
| `save-count`      | `fail`    | Its console event reports a different count.          |
| `save-storage`    | `unknown` | Storage was not requested, so absence proves nothing. |

Append `--matching` to make the count agree. Storage remains unknown. A failed or
unknown verification is a valid analysis result, not a transport error. The script
exits successfully only when its deliberately chosen outcomes and CLI/MCP parity
match expectations.

On command failure the example retains the complete JSON diagnostics and stderr
in its output directory. Browser availability and cleanup are checked at runtime;
an unavailable provider or incomplete cleanup is a failure, not a passing recipe.

## Capture and compare with the CLI

The example writes two scenario files with this shape; use the respective original
or candidate URL and your existing browser executable:

```json
{
  "browser": {
    "mode": "launch",
    "executable_path": "/absolute/path/to/chromium",
    "headless": true
  },
  "start_url": { "url": "http://127.0.0.1:41001/" },
  "environment": {
    "viewport": { "width": 800, "height": 500, "device_scale_factor": 1 },
    "locale": "en-US",
    "timezone": "UTC",
    "color_scheme": "light",
    "reduced_motion": "reduce"
  },
  "actions": [
    {
      "step_id": "save",
      "action": "click",
      "timeout_ms": 10000,
      "locator": { "kind": "role", "role": "button", "name": "Save" }
    }
  ],
  "capture": {
    "after_each_step": ["screenshot", "dom", "url"],
    "at_end": ["screenshot", "dom", "url"],
    "events": ["console"]
  }
}
```

```sh
rea capture-browser-scenario original-scenario.json --json > original-evidence.json
rea capture-browser-scenario candidate-scenario.json --json > candidate-evidence.json
```

Keep the complete Evidence envelopes, including the parameters that commit the
scenario, viewport and actions. The detached normalized result cannot supply this
binding. Comparing an observation with itself does not establish reconstruction
agreement.

Create `origin-mapping.json` with the actual origins:

```json
{
  "before_origin": "http://127.0.0.1:41001",
  "after_origin": "http://127.0.0.1:41002"
}
```

```sh
rea compare-web-captures original-evidence.json candidate-evidence.json --origin-mapping-json origin-mapping.json --json > capture-comparison.json
rea compare-web-screenshots original-evidence.json candidate-evidence.json --step-id save --origin-mapping-json origin-mapping.json --channel-threshold 0 --json > pixel-comparison.json
```

Origin correspondence is committed in the comparison. It maps typed URL fields,
preserving paths, queries and fragments; it does not replace text in DOM, logs or
bodies. Browser, environment, alignment and coverage requirements still apply.
`step_id` selects a screenshot from each scenario. For standalone
`capture_web_screenshot` Evidence, omit `step_id`.

## Equivalent MCP calls

Call `capture_browser_scenario` with each scenario object above. Use its complete
Evidence inline, or its exact ID while retained in that same session:

```json
{
  "name": "compare_web_captures",
  "arguments": {
    "left": {
      "kind": "retained-evidence",
      "evidence_id": "<original Evidence ID>"
    },
    "right": {
      "kind": "retained-evidence",
      "evidence_id": "<candidate Evidence ID>"
    },
    "origin_mapping": {
      "before_origin": "http://127.0.0.1:41001",
      "after_origin": "http://127.0.0.1:41002"
    }
  }
}
```

```json
{
  "name": "compare_web_screenshots",
  "arguments": {
    "left": {
      "kind": "retained-evidence",
      "evidence_id": "<original Evidence ID>"
    },
    "right": {
      "kind": "retained-evidence",
      "evidence_id": "<candidate Evidence ID>"
    },
    "step_id": "save",
    "origin_mapping": {
      "before_origin": "http://127.0.0.1:41001",
      "after_origin": "http://127.0.0.1:41002"
    },
    "channel_threshold": 0
  }
}
```

Replace references with complete Evidence to use portable inline inputs. MCP
retains the sources together with the derived comparison. IDs alone are not
portable to a new server session. Legacy raw captures and PNG artifacts remain
accepted for detached comparison, but do not establish the source closure required
by reconstruction verification.

## Declare finite requirements

Use the two comparison Evidence IDs in this specification:

```json
{
  "name": "Save fixture reconstruction",
  "claims": [
    {
      "claim_id": "save-appearance",
      "title": "Saved screen has identical pixels",
      "kind": "web-screenshot",
      "comparison_evidence_id": "<pixel comparison Evidence ID>",
      "dimension": "pixels",
      "maximum_changed_ratio": 0
    },
    {
      "claim_id": "save-count",
      "title": "Save reports the same count",
      "kind": "web-scenario",
      "comparison_evidence_id": "<capture comparison Evidence ID>",
      "dimension": "events",
      "step_id": "save"
    },
    {
      "claim_id": "save-storage",
      "title": "Save preserves storage",
      "kind": "web-scenario",
      "comparison_evidence_id": "<capture comparison Evidence ID>",
      "dimension": "storage",
      "step_id": "save"
    }
  ]
}
```

`channel_threshold` controls which pixels count as changed. `maximum_changed_ratio`
is the claim's acceptance threshold, from zero to one. A `different` comparison
can satisfy a nonzero tolerance; it remains a different observation.

The runnable example writes `verification-request.json` containing
`{ "specification": <the specification>, "evidence_bundle": <canonical bundle> }`.
It assembles both source and comparison records with `createEvidenceBundle`;
REA validates the bundle manifests, record identities and references.

```sh
rea verify-reconstruction verification-request.json --json
```

Through MCP, call `verify_reconstruction` with
`{ "specification": <the same specification> }`. The server uses the records
retained in its session; its Evidence `normalized_result` matches the CLI result.
Every claim includes status, source links, limitations and unknowns. Missing,
truncated or incompatible evidence cannot become a passing claim.

The console claim covers only the captured report from this finite action. It
does not prove a persistence operation happened. Persistence requires its own
selected observation and comparable proof.
