# Research and reconstruct a CLI feature

This recipe starts with a finite analyst question, investigates a shipped
JavaScript CLI, writes an Evidence-cited reconstruction brief, and tests an
independent implementation. It retains the initial failure, its first divergence,
the corrected result, and portable Evidence. REA supplies observations and
verification; the included deterministic builder is an example implementer, not
an integrated code-generation model.

## Run the complete example

Use the pinned Node/npm versions and build REA as described in
[the development guide](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md). Process capture requires Linux or
macOS with the native PTY dependency available. Native Windows capture is
unavailable because descendant cleanup is not verified; WSL can capture Linux
commands only. The example probes this capability before creating the output
directory or running its targets, and fails with the provider's precise reason.
See [process capture](../runtime/process-capture.md) for the supported authority and limits.

From the repository root, choose an absolute output directory that does not yet
exist. Its parent must exist:

```bash
npm run build:cached
node scripts/examples/cli-reconstruction.mjs /tmp/rea-cli-recipe-001
```

Only the fixture shipped in this repository runs. There are no downloads,
network services, credentials, or model calls. Existing investigation directories
are never overwritten. The successful recipe exits 0 even though its deliberate
first candidate fails verification and the corrected investigation still has an
unknown filesystem claim. A missing capability, failed tool call, unexpected
result, or failed cleanup exits nonzero. Tool failures retain diagnostics in the
new investigation directory when it has already been created.

The final `recipe-summary.json` and stdout report:

| Revision                        | Declared terminal/exit claims                       | Filesystem claim | Overall |
| ------------------------------- | --------------------------------------------------- | ---------------- | ------- |
| Initial independent candidate   | Three pass; valid sum output fails (`8` versus `7`) | Unknown          | Fail    |
| Corrected independent candidate | All four pass                                       | Unknown          | Unknown |

These outcomes are evidence about the two selected invocations, not a claim of
global CLI equivalence.

## 1. Ask a finite question and declare inputs

`scope.json` records: can an independent implementation reproduce the original
for `sum 2 5` and `sum 2 nope`? Each invocation has a terminal and exit claim.
An additional filesystem claim demonstrates a deliberately unobserved dimension.
Other inputs, timing/order equivalence, network behavior, and complete process
trees are outside the answer.

The selected executable is the current Node binary. The selected script is an
explicit absolute argument. Original and candidate captures use the same working
directory, explicit `LANG`, `LC_ALL` and `NO_COLOR`, terminal size, timeouts,
settlement interval, empty interaction schedule, and normalization. They select
no filesystem paths. The harness inherits other environment variables without
persisting them; their contents remain unknown. The generated `*-scenario.json`
files retain all declared caller inputs.

## 2. Inspect the shipped artifact and observe the feature

The example copies its own small CLI into an extracted application directory and
calls the public static-analysis command before executing it:

```bash
node scripts/rea.mjs analyze-javascript-application \
  /tmp/rea-cli-recipe-001/original --artifact-format directory --json
node scripts/rea.mjs capture-process \
  /tmp/rea-cli-recipe-001/original-valid-scenario.json --json
node scripts/rea.mjs capture-process \
  /tmp/rea-cli-recipe-001/original-invalid-scenario.json --json
```

`original-static-evidence.json` records shipped JavaScript analysis. The two
`original-*-capture.json` files retain real PTY observations, rendered frames,
exit, settlement, manifests, coverage and residual unknowns. PTY data may contain
`\r\n` rather than `\n`. The process manifest hashes identify **Node**, not the
JavaScript argument. `reconstruction-brief.json` separately records the selected
script path and SHA-256, its static Evidence ID, the explicit invocations and
runtime Evidence IDs. This associates the selected artifact with the experiment;
it does not manufacture an automatic causal trace from source to runtime.

The brief distinguishes observed output/exit from the inferred implementation
requirement. Source inspection helps explain the feature; the selected runtime
observations are the acceptance reference. Static analysis does not prove that
every source branch executed.

## 3. Implement from the brief

An agent or developer normally implements a candidate from the brief and its
cited records. The reproducible example uses
`scripts/examples/fixtures/cli-sum-builder.mjs` to write two independent versions.
It reads the generated brief, validates its two declared cases, derives the
additive offset from the observed valid output and operands, and uses the brief's
observed invalid-output text and both exit codes. It never reads, imports or
invokes the original. The additive algorithm is an explicit implementation
inference for this small example. The `initial` revision deliberately adds one
to the derived offset, producing `8`; `corrected` uses the derived offset,
producing `7`. Changing the brief's facts changes the generated behavior; the
portable acceptance test checks that dependence. `initial-build.json` and
`corrected-build.json` retain the brief SHA-256, cited source Evidence IDs and
derived/implemented offsets. Candidate bytes, hashes and separate static-analysis
Evidence remain under `initial/` and `corrected/`.

The builder can also be replayed directly with the retained brief and a new file:

```bash
node scripts/examples/fixtures/cli-sum-builder.mjs \
  /tmp/rea-cli-recipe-001/candidate-from-brief.mjs corrected \
  /tmp/rea-cli-recipe-001/reconstruction-brief.json
node /tmp/rea-cli-recipe-001/candidate-from-brief.mjs sum 2 5
```

The builder's known defect is an educational fixture. It is not a general
algorithm for synthesizing an implementation, and REA does not claim authorship
of candidate code written by an external agent.

## 4. Compare, localize, correct, and repeat

The original captures are reused. Each candidate is captured with the same two
declared inputs. The original observations generate explicit `*-trace-policy.json`
files: all observed raw/rendered terminal and lifecycle payloads and their counts
must match, while only top-level `sequence`, `at_ms`, and `elapsed_ms` are ignored.
No event order or timing equivalence is asserted. Extra output, changed text,
changed exit status or changed settlement state is not ignored. Different PTY
chunking can fail this strict policy; investigate that result rather than hiding
it with a broad normalization pattern.

Terminal and lifecycle have separate trace specifications/comparisons. This
lets an output failure be localized without turning scheduling differences in
the otherwise matching exit into a second acceptance failure. Each claim selects
the comparison that declares its own observation family.

```bash
node scripts/rea.mjs compare-process-captures \
  /tmp/rea-cli-recipe-001/original-valid-capture.json \
  /tmp/rea-cli-recipe-001/initial-valid-capture.json \
  /tmp/rea-cli-recipe-001/valid-trace-policy.json --json
node scripts/rea.mjs verify-reconstruction \
  /tmp/rea-cli-recipe-001/initial-verification-request.json --json
node scripts/rea.mjs verify-reconstruction \
  /tmp/rea-cli-recipe-001/corrected-verification-request.json --json
```

`initial-valid-comparison.json` localizes the first terminal divergence, while
the invalid-input comparison passes its declared terminal/exit claims. After
correcting the accumulator, both comparisons pass those claims. No filesystem
selection means filesystem equivalence remains `unknown`, even when both recorded
file lists are empty. Sampled process trees and unobserved network/environment
also remain limitations; omitted dimensions do not become verified implicitly.
`correction.json` connects the failed claim to its comparison, both source
Evidence IDs, the observed divergence, candidate identity, brief digest and the
specific accumulator change. The corrected candidate is checked under the same
inputs and acceptance policy.

Each `*-verification-request.json` contains the finite `specification` and its
explicit `evidence_bundle`. Each `*-bundle.json` preserves the complete source
closure, static investigation and comparisons, including the failed first round.
`*-cli-verification.json` is the normalized verification result. Passing a finite
claim does not resolve unrelated unknowns or establish global equivalence.

## 5. Continue through MCP with the same portable investigation

The executable example starts a **fresh** production stdio MCP session for each
round, imports the exact portable bundle, verifies the same specification, and
asserts that the normalized MCP result equals the CLI result:

```json
{
  "name": "import_evidence_bundle",
  "arguments": { "path": "/tmp/rea-cli-recipe-001/corrected-bundle.json" }
}
```

The following runnable client uses the exact generated objects. Run it from the
repository root after the complete example (change the single directory argument
to your output path):

```bash
node --input-type=module - /tmp/rea-cli-recipe-001 <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const output = process.argv[2];
const request = JSON.parse(await readFile(join(output, 'corrected-verification-request.json'), 'utf8'));
const expected = JSON.parse(await readFile(join(output, 'corrected-cli-verification.json'), 'utf8'));
const client = new Client({ name: 'cli-recipe-replay', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['scripts/rea.mjs', 'mcp'], stderr: 'pipe' });
try {
  await client.connect(transport);
  const imported = await client.callTool({ name: 'import_evidence_bundle', arguments: { path: join(output, 'corrected-bundle.json') } });
  assert.ok(!imported.isError);
  const reply = await client.callTool({ name: 'verify_reconstruction', arguments: { specification: request.specification } });
  assert.ok(!reply.isError);
  assert.deepEqual(reply.structuredContent.normalized_result, expected);
  console.log(JSON.stringify(reply.structuredContent.normalized_result, null, 2));
} finally {
  await Promise.all([client.close(), transport.close()]);
}
JS
```

The full request saved on disk is directly usable by a client. MCP wraps the
result in Evidence; compare `normalized_result` with the CLI output.
`corrected-mcp-verification.json` retains that response. Keeping a session alive
retains the imported Evidence for subsequent verification calls.

For a fresh investigation conducted entirely over MCP, the corresponding tools
are `analyze_javascript_application`, `capture_process_scenario`, and
`compare_process_captures`; the process comparison accepts complete `left` and
`right` capture Evidence and optional `trace_spec`. Such comparisons also create
session-owned unknown histories. Export that session's full bundle with
`export_evidence_bundle` and use **that same bundle** for CLI/MCP parity. The
example imports its CLI bundle into fresh sessions so unrelated or newly created
unknown histories cannot change the question silently. It never removes unknowns
to obtain a passing result.

The example also retrieves the native `reconstruct_cli_feature` MCP prompt with
the selected original script, working directory and finite feature, and retains
it in `recipe-prompt.md`. It guides research, the brief, external implementation
and correction; prompt retrieval does not run a builder or expand
target-execution authority.

## Verification scope

```bash
npm run test:focused -- tests/acceptance/process/cliReconstructionRecipe.test.ts
```

The portable test executes the source-owned original and both independent
candidate revisions and checks real stdout and failure exit codes. It does not
claim PTY-provider coverage. The full recipe acceptance test probes the actual
native PTY seam and is explicitly skipped when unavailable; supported hosts run
the entire research/failure/correction flow through compiled CLI and MCP. A
separate unavailable-host test checks the precise diagnostic and verifies that
no investigation directory was created. Recorded comparisons remain usable on
Windows, as described in [process capture](../runtime/process-capture.md).
