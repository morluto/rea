# Reconstruct a web interaction from observations

This recipe follows one Save interaction through original evidence, a cited brief,
an independent generated candidate, a failing comparison, a correction and final
verification. It uses the tools introduced in
[web reconstruction verification](web-reconstruction-verification.md).

## Run the complete example

Build the checkout with its pinned toolchain and select an existing Chromium-compatible
browser plus a new absolute output directory:

```sh
npm run build:cached
node scripts/examples/web-reconstruction-recipe.mjs /absolute/path/to/chromium /absolute/path/to/new-web-recipe
```

For Windows:

```powershell
node scripts/examples/web-reconstruction-recipe.mjs "C:/Program Files/Google/Chrome/Application/chrome.exe" "D:/analysis/new-web-recipe"
```

The script serves only its own pages on two loopback ports. It retrieves the
`reconstruct_web_feature` MCP prompt, captures the original through the public CLI,
and writes a reconstruction brief from the actual captured Save event and image.
The example's deterministic builder writes `candidate.html` with an independent
event-delegation implementation and a deliberate counter defect. It does not
invoke the original page to obtain its answer.

Both comparison rounds use the public CLI and stdio MCP with exact result parity.
An explicit origin mapping pairs original and candidate. The correction uses the
original report cited in the brief, while the original capture is reused as a
historical reference for the same finite case.

| Claim                 | Initial candidate | Corrected candidate |
| --------------------- | ----------------- | ------------------- |
| Saved screen pixels   | `pass`            | `pass`              |
| Save's reported count | `fail`            | `pass`              |
| Storage persistence   | `unknown`         | `unknown`           |

The final overall status remains `unknown` because storage was not observed.
`required_claims_passed` means the two explicitly required visual/report cases
passed; it does not remove the separately reported storage unknown.

## Inspect the result

The new output directory preserves:

- `recipe-prompt.md`: native MCP recipe with the selected context.
- `original-scenario.json` and `original-evidence.json`: exact reference case and observation.
- `reconstruction-brief.json`: question, observed report/image references, requirements,
  inferred implementation choices, stopping criteria and unknowns.
- `candidate-before.html` and `candidate.html`: failing and corrected independent builds.
- `before-*` and `after-*`: candidate scenarios, source Evidence, comparisons,
  specifications and CLI/MCP verification results.
- `correction.json`: failed claim, supporting Evidence and the selected correction.
- `evidence-bundle.json` and `handoff.json`: portable evidence closure, per-claim
  outcomes, implementation digests and remaining unknowns.

An existing output directory is refused. Failed public commands retain complete
JSON diagnostics and stderr rather than treating an unavailable capture as success.
The script closes its owned servers and MCP connections; each capture reports its
browser cleanup outcome.

## Verify the example

The acceptance suite checks missing reference reports, refusal to overwrite an
existing directory and the complete CLI/MCP correction cycle. The real-browser
case runs only when an executable is explicitly selected:

```sh
REA_BROWSER_EXECUTABLE=/absolute/path/to/chromium npm run test:focused -- tests/acceptance/browser/webReconstructionRecipe.test.ts
```

On Windows:

```powershell
$env:REA_BROWSER_EXECUTABLE = "C:/Program Files/Google/Chrome/Application/chrome.exe"
npm run test:focused -- tests/acceptance/browser/webReconstructionRecipe.test.ts
```

Without that selection, the real-browser case is reported as skipped. The
remaining tests use modeled producer facts and do not establish browser behavior.

## Apply the recipe to your feature

Retrieve `reconstruct_web_feature` with the original URL and feature. Replace the
example's deterministic builder with the agent's ordinary coding tools and the
user's selected stack. Declare cases and viewport/state before comparing. Keep
each requirement attached to its original Evidence and retain both failing and
corrected observations.

Use the existing [CLI/MCP calls](web-reconstruction-verification.md) with full
Evidence or retained references. Do not broaden origin scope or normalize DOM,
logs or response bodies simply because a difference is inconvenient. Visual
agreement is separate from the observed report and from unobserved effects.

This is a bounded source-owned fixture workflow, not a general website generator
or a measurement of an AI coding agent's reconstruction quality.
