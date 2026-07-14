# Guided MCP prompts and completion

REA exposes six provider-neutral investigation workflows through the MCP
`prompts` capability. They complement the 70 tools; they do not add, remove, or
invoke tools by themselves.

## Prompt inventory

| Prompt                            | Purpose                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `investigate_feature`             | Trace a feature from discovery into bounded function evidence.                        |
| `compare_application_versions`    | Compare two shipped artifacts, with optional static and runtime follow-up.            |
| `verify_reconstruction`           | Evaluate a finite reconstruction specification against retained comparison Evidence.  |
| `trace_crash`                     | Correlate a crash symptom with static paths and optional Process Capture v4 evidence. |
| `audit_residual_unknowns`         | Audit current residual-unknown heads and evidence-qualified resolution.               |
| `prepare_bounded_process_capture` | Design an approval-gated, bounded process experiment before execution.                |

Every rendered prompt provides an ordered list of current REA tool names. It
also requires the agent to keep observations, inferences, and unknowns
distinct. Requested prompt arguments and completion choices are rendered as
untrusted selection data, not instructions or authorization.

Use standard MCP discovery and retrieval:

```json
{ "method": "prompts/list", "params": {} }
```

```json
{
  "method": "prompts/get",
  "params": {
    "name": "investigate_feature",
    "arguments": {
      "feature": "offline search",
      "document": "Notes"
    }
  }
}
```

The server advertises `listChanged: true`. Updating a registered guided prompt
emits `notifications/prompts/list_changed`, allowing clients to refresh their
cached prompt catalog.

## Session-aware completion

MCP `completion/complete` currently completes prompt arguments and resource
template variables. It does not define completion for arbitrary tool-call
arguments. REA therefore attaches completion to optional guided-prompt
arguments that feed later tool selection; it does not claim protocol-level
completion for every REA tool.

```json
{
  "method": "completion/complete",
  "params": {
    "ref": {
      "type": "ref/prompt",
      "name": "investigate_feature"
    },
    "argument": {
      "name": "procedure",
      "value": "0x10"
    },
    "context": {
      "arguments": {
        "document": "Notes"
      }
    }
  }
}
```

Completion sources are live projections of the current session:

| Argument family     | Source and filtering                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Document            | Current provider `list_documents` result.                                                                                                                                                              |
| Procedure           | Bounded pagination over `list_procedures`; observed addresses are offered from partial results, while names require exhaustive discovery and a unique address. Optional document context is forwarded. |
| Provider            | Provider identities declared by the current binary session.                                                                                                                                            |
| Evidence            | Evidence IDs retained in the current session ledger.                                                                                                                                                   |
| Process capture     | Evidence IDs whose operation and validated result identify Process Capture v4.                                                                                                                         |
| Artifact manifest   | Manifest IDs from schema-valid retained artifact inventories.                                                                                                                                          |
| Artifact occurrence | Occurrence IDs present in schema-valid retained artifact inventory pages.                                                                                                                              |
| Residual unknown    | Current non-resolved unknown heads only.                                                                                                                                                               |

Suggestions are Unicode-normalized, case-insensitive prefix matches. The server
deduplicates them, rejects values longer than 4,096 characters, and sorts by
code point for deterministic results. It scans at most 10,000 candidates;
procedure discovery is further bounded to 5,000 unique addresses in pages of 500. If that bound is reached before exhaustive procedure discovery, only
observed addresses are suggested because global name uniqueness is unknown.

The MCP result carries at most 100 `values`. `total` is the number of matching
candidates found within REA's scan bound, and `hasMore` reports whether more
than 100 were found. The MCP completion response has no offset or cursor, so a
client narrows a large result by sending a longer prefix rather than requesting
another page.

## Lifecycle and safety

Completion has no cache in REA. Opening or switching a target changes document
and procedure suggestions on the next request. Closing the binary clears its
Evidence ledger and residual-unknown registry, so identifiers from the closed
session are no longer suggested. Provider errors, unsupported operations, and
malformed provider output produce an empty completion list rather than an
unverified identifier.

Suggestions never grant permission. In particular, selecting an artifact
occurrence does not authorize extraction, selecting an unknown does not
authorize mutation, and selecting a prior capture does not authorize process
execution. The corresponding tools retain their existing approval, policy,
effect, and validation boundaries.
