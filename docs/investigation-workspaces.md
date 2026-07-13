# Persistent investigation workspaces

REA can run a deterministic artifact investigation across two versions and
persist its Evidence beyond a CLI process or MCP session. The CLI and MCP use
the same application workflow.

## CLI

First allow the directory that will own the workspace, then explicitly approve
the write:

```bash
export REA_EVIDENCE_ROOTS_JSON='["/absolute/path/to/evidence"]'
export REA_INVESTIGATION_INPUT_ROOTS_JSON='["/absolute/path/to/releases"]'

rea investigate-versions \
  /absolute/path/to/version-1 \
  /absolute/path/to/version-2 \
  /absolute/path/to/evidence/releases.json \
  --workspace-name releases \
  --yes
```

The two versions may be regular artifacts or directories supported by the
artifact graph provider. Both must resolve beneath an explicitly configured
`REA_INVESTIGATION_INPUT_ROOTS_JSON` root. The workspace parent must already
exist beneath `REA_EVIDENCE_ROOTS_JSON`. REA never creates an allowlisted root
implicitly.

Use `--expected-revision N` when an external coordinator needs an explicit
compare-and-swap guard. Traversal, byte, page, and comparison limits are also
available as CLI options.

## MCP

`find_changed_behavior` retains its existing aggregation mode. Its additive
`investigation_run` mode starts or resumes the same persistent workflow:

```json
{
  "investigation_run": {
    "approved": true,
    "workspace_path": "/absolute/path/to/evidence/releases.json",
    "workspace_name": "releases",
    "left_path": "/absolute/path/to/version-1",
    "right_path": "/absolute/path/to/version-2",
    "options": {
      "max_entries": 10000,
      "max_total_bytes": 1073741824,
      "max_entry_bytes": 268435456,
      "max_compression_ratio": 1000,
      "max_depth": 20,
      "max_path_bytes": 4096,
      "page_size": 500,
      "change_limit": 500
    }
  }
}
```

Exactly one of `comparisons` or `investigation_run` is accepted. The MCP tool
inventory remains unchanged.

## Checkpoints and reuse

One run has four ordered stages:

1. Inventory the left version.
2. Inventory the right version.
3. Compare the complete artifact Evidence page sets.
4. Derive the changed-behavior report.

The inventory checkpoint is written first, followed by the comparison and final
report checkpoints. A process interrupted after a checkpoint can resume from
the last complete stage. A completed run is reused when both graph commitments
and every bounded option are identical.

The run ID is a SHA-256 commitment to both root and graph digests plus the
normalized options. Local paths and timestamps do not affect that identity.
Changing either artifact or a budget creates a new run in the same workspace;
it does not overwrite the earlier run.

## Integrity and concurrency

A workspace contains a canonical Evidence v2 bundle plus run manifests. Each
workspace revision has a deterministic digest and points to the prior revision
digest. Parsing verifies:

- the workspace, run, Evidence, graph, and revision identities;
- canonical ordering and unique run IDs;
- every run-to-Evidence reference;
- stage and completion-state consistency.

Writes are canonical JSON, atomic, fsynced, and mode `0600`. REA rejects
workspace paths outside `REA_EVIDENCE_ROOTS_JSON`, symlink destinations,
artifact inputs outside `REA_INVESTIGATION_INPUT_ROOTS_JSON`,
oversized or deeply nested JSON, stale expected revisions, and concurrent lock
holders. Lock or CAS conflicts fail without mutating the workspace; callers may
retry the same idempotent request.

## Truth boundary

The automatic run currently observes shipped artifact structure. Artifact
changes are static behavior candidates, not runtime observations or causal
claims. Without controlled process comparison Evidence, `behavior_status`
remains `unknown` even when static differences are present. Provider
limitations, incomplete comparison pages, and unsupported container expansion
remain explicit in the final Evidence.

Automatic Hopper function matching, process replay, protocols, UI comparison,
and reconstruction verification are not yet stages of this run. Existing
manual comparison Evidence can still be aggregated through the original
`find_changed_behavior` mode.
