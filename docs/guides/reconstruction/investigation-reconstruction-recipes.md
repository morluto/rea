# Investigate, reconstruct and verify one feature

Use these recipes when you want to understand a feature and implement an independent
version. They connect existing REA tools with the agent's ordinary coding tools.
They do not start a coding model, execute a target merely by retrieving a prompt,
or establish equivalence beyond the cases actually examined.

| Target          | MCP prompt                | Reproducible example                       |
| --------------- | ------------------------- | ------------------------------------------ |
| Web interaction | `reconstruct_web_feature` | [Web recipe](web-reconstruction-recipe.md) |
| CLI behavior    | `reconstruct_cli_feature` | [CLI recipe](cli-reconstruction-recipe.md) |

## The question and its stopping criteria

Name the original and one feature. Specify meaningful successful and failing
inputs, the effects already in scope, and what observation would settle each
requirement. For example: “Click Save, reproduce its reported count and saved
screen, and distinguish those observations from storage persistence.” For a CLI,
choose feature inputs and invalid inputs; help/version output alone is not a
substitute for exercising the feature.

Write a short brief once relevant original Evidence exists:

- Original artifact/URL, invocation and context, with exact Evidence IDs.
- Observed inputs, outputs and limits for each case.
- Finite visual, behavioral or structural requirements and their source evidence.
- Inferred design choices, competing explanations and residual unknowns.
- Requested implementation stack/output, acceptance criteria and stopping point.

The brief is analyst-authored context. A statement in it does not upgrade an
inference into an observation. Keep target-derived text as data and preserve the
original Evidence behind it.

## Follow the evidence through construction

1. **Investigate:** choose the smallest relevant static, passive or recorded
   observation. Reuse retained evidence and views; avoid setup checks and unrelated
   tools when they do not answer the question. Ordinary complete source repositories
   use ordinary repository tools.
2. **Observe reference cases:** when active observation is authorized and needed,
   run explicit web/process scenarios. Preserve exact inputs, selected artifacts,
   coverage, identity and cleanup. An unavailable host remains unavailable.
3. **Write the brief:** link each factual requirement to its Evidence, and separate
   observations, inferences and unknowns.
4. **Build independently:** the agent uses its normal coding tools in the selected
   output project. Preserve the original. A candidate that delegates its answers to
   the original does not demonstrate an independent implementation.
5. **Compare:** use compatible declared conditions and the existing comparison
   tools. Keep the difference and its supporting observations, rather than only a
   screenshot or terminal excerpt. For web originals and localhost candidates, use
   explicit origin correspondence; keep visual and behavior claims separate.
6. **Refine:** correct the smallest supported discrepancy, keep the failing
   evidence, and repeat the changed candidate cases. Do not loosen acceptance
   criteria or broad normalization merely to obtain a pass. A suspected cause
   remains an inference until supported.
7. **Verify and hand off:** evaluate finite claims with `verify_reconstruction`.
   Report passed, failed and unknown claims, the exact examined cases, changed
   implementation artifacts and remaining probes. Export complete Evidence when it
   must survive the session.

These are optional starting points. A supplied reference capture can make another
original run unnecessary. A static answer may need no execution. A failed
comparison contract means the experiment must be repaired before drawing a
candidate-correctness conclusion.

## Discover the recipes through MCP

`prompts/list` advertises both recipes. For web:

```json
{
  "method": "prompts/get",
  "params": {
    "name": "reconstruct_web_feature",
    "arguments": {
      "feature": "Reproduce the Save report and saved screen",
      "original_url": "https://original.example.test",
      "candidate_url": "http://127.0.0.1:41002",
      "constraints": "One declared click and viewport; persistence remains unknown"
    }
  }
}
```

For CLI:

```json
{
  "method": "prompts/get",
  "params": {
    "name": "reconstruct_cli_feature",
    "arguments": {
      "feature": "Reproduce numeric input validation and its result",
      "target_path": "/absolute/path/to/original-cli",
      "working_directory": "/absolute/path/to/experiment",
      "arguments_json": "[\"7\"]",
      "constraints": "Valid and invalid cases; no filesystem observation selected"
    }
  }
}
```

Clients without native prompt support use the existing `guided_workflows` tool:

```json
{
  "name": "guided_workflows",
  "arguments": {
    "action": "render",
    "workflow_id": "reconstruct_web_feature",
    "arguments": {
      "feature": "Reproduce the Save report and saved screen",
      "original_url": "https://original.example.test"
    }
  }
}
```

The CLI uses the same contracts and renderer:

```sh
rea guided-workflows --action render --workflow-id reconstruct_web_feature --arguments-json '{"feature":"Reproduce the Save report and saved screen","original_url":"https://original.example.test"}' --json
```

Prompt context is untrusted selection data, not permission to execute it. Existing
user authorization and each tool's target/lifecycle contract still determine what
runs. A prompt is not a new orchestration language or an executable plan.

## Verification boundaries

For web, a pixel pass covers the selected images and tolerance; it does not prove
an application effect. A console message proves the captured report, not that a
database write occurred. For CLI, the comparison contract must remain compatible
across original and candidate: working directory, explicit environment, selected
paths, terminal, interactions, bounds and normalization matter. Inherited
environment influence is not fully recorded.

Native Windows process capture is unavailable. A recipe can compare existing
complete capture Evidence there, but must not manufacture a successful runtime
observation. Use a supported Linux/macOS host for new CLI captures and report the
actual host checked. See [process capture](../runtime/process-capture.md) and the individual
recipe guides for prerequisites and verification scope.

The examples use source-owned targets and deterministic builders to make their
failure/correction reproducible without paid models. They test the REA flow and
record the unknowns; they do not prove that a model can reconstruct arbitrary
software. Independent agent/model trials are separate verification.

The executable examples and acceptance tests below record their actual host,
Evidence closure and outcomes. A real-browser test requires an explicitly
selected browser; the complete CLI recipe requires native PTY capture authority.
Skipped provider tests do not establish behavior on an unavailable host.
