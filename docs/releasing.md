# Releasing from a checkpoint

REA releases use a frozen source checkpoint. Main can continue accepting
changes while a release is tested and published. The Release workflow runs
on `release/*` branches; main pushes do not refresh release PRs.

## 1. Cut the release branch

Choose the next version from the unreleased Conventional Commits, including
breaking changes. Record the full source SHA and create `release/VERSION` at
that commit. The version is a maintainer choice; Release Please's proposed
version must agree before publication.

For example, after selecting a reviewed commit for 5.0.0:

```bash
git fetch origin main
git branch release/5.0.0 SOURCE_SHA
git push origin release/5.0.0
```

Replace `SOURCE_SHA` with the selected full commit SHA. The checkpoint must
include this release workflow and CI support for release branches. For an
older checkpoint, backport only the release infrastructure first and record
that additional commit. Do not merge later implementation changes into the
release branch or rebase the candidate onto a moving main.

The branch push runs Release Please against that branch and opens a PR for
the version, changelog, and registry metadata. The generation step normalizes
the product catalog. To retry preparation after a failed run, select the same
frozen branch explicitly:

```bash
gh workflow run release.yml --ref release/5.0.0
```

## 2. Review and merge the bot PR

Record the final bot PR head after normalization. Approve GitHub-blocked bot
workflow runs for that head when needed. Review the candidate's version,
notes, generated metadata, and package contents. Wait for the candidate's CI
and relevant real-provider checks. Routine local iterations need focused
checks; CI owns full deterministic coverage and platform lanes. If an artifact
or real-provider check is unavailable, report that limit before deciding to
publish.

Merge the reviewed PR into `release/5.0.0` with its head SHA matched. **This
merge authorizes and triggers publication.** Further main commits do not change
this candidate. Do not push or merge anything else into the release branch
while publication is running. A necessary release fix must be reviewed and
tested before the bot PR merges and establishes a new recorded checkpoint.

## 3. Verify publication

The merge push runs Release Please again, creates the tag and GitHub release,
and publishes npm followed by MCP Registry metadata. Both publishers check
out Release Please's exact release SHA. The triggering workflow also runs
from that release commit so npm's provenance records the actual source.

Before invoking Release Please, the workflow checks that the release branch
still equals the triggering SHA and rejects main or tag refs. Before either
registry publish, it rejects a mismatch between the tagged release SHA and
the triggering SHA. These checks detect moved branches; maintainers must also
keep the release branch frozen throughout publication.
See [npm's provenance implementation](https://github.com/npm/cli/blob/v11.16.0/workspaces/libnpmpublish/lib/provenance.js)
for the use of GitHub's workflow ref and commit SHA.

The workflow builds the bundled Windows controls and verifies the packaged
artifact before npm publication. It then verifies the published CLI, the
capability-scoped MCP catalog, and the isolated package update path before
publishing MCP Registry metadata.

Record these outcomes separately:

- GitHub release and tag, including the resolved commit SHA.
- npm's exact version and integrity, with the published-package canary passed.
- MCP Registry's exact server version and matching npm package version.

A GitHub tag alone does not establish npm or MCP Registry publication.

## Sync metadata back to main

After publication, open a PR from the release branch back to main. Preserve
main's later implementation changes and resolve generated-file conflicts by
regenerating from the combined contracts with the released package version.
Review and test this synchronization PR, then use a merge commit so the release
tag remains in main's ancestry. Keep the released tag unchanged.

Close any superseded rolling release PR. Future releases repeat the checkpoint
procedure from main; never resume automatic release-PR refreshes on main pushes.

## Partial publication and retries

Inspect the failed job and public registry state before retrying. When npm is
already published, the npm job verifies that exact version instead of
publishing it again. Re-run failed jobs in the original publication run so its
release SHA and outputs stay fixed. If only MCP publication failed, retry that
job after checking that the npm canary succeeded.

Do not start a fresh workflow run to repair an already-created release:
Release Please will not create the same release again. Do not move the tag,
delete the release, or unpublish npm as a retry. A defective public package
requires a reviewed correction and a new version.
