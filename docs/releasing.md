# Releasing from a checkpoint

REA releases use an explicit source checkpoint. Main can continue accepting
changes while a release is tested and published. The Release workflow runs
only when a maintainer dispatches it; main pushes do not refresh release PRs.

## 1. Select the source

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

## 2. Prepare the bot PR

Run the workflow definition from main and select the frozen source separately:

```bash
gh workflow run release.yml --ref main \
  -f release_branch=release/5.0.0 -f phase=prepare
```

Release Please targets that branch and prepares its version, changelog, and
registry metadata. The existing generation step normalizes the product
catalog. Preparation cannot create a GitHub release or publish a package.
Record the final bot PR head after normalization. Approve GitHub-blocked bot
workflow runs for that head when needed.

Review the candidate's version, notes, generated metadata, and package
contents. Wait for the candidate's CI and relevant real-provider checks.
Routine local iterations need focused checks; CI owns full deterministic
coverage and platform lanes. If an artifact or real-provider check is
unavailable, report that limit before deciding to publish.

Merge the reviewed PR into `release/5.0.0` with its head SHA matched. Further
main commits do not change this candidate. A necessary release fix belongs
on the release branch, must be reviewed and tested, and establishes a new
recorded checkpoint.

## 3. Publish the reviewed merge

After the release PR has merged:

```bash
gh workflow run release.yml --ref release/5.0.0 \
  -f release_branch=release/5.0.0 -f phase=publish
```

Publication creates the release from the merged bot PR without preparing or
updating another PR. Both npm and MCP Registry jobs check out Release Please's
exact release SHA. They do not build the current main tip or a mutable branch.
The publish dispatch runs from the frozen release branch so npm's provenance
records the actual release commit. The workflow rejects a mismatch between
the tagged release SHA and the dispatch SHA before either registry publish.
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

## 4. Sync metadata back to main

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

Do not dispatch a fresh publish phase to repair an already-created release:
Release Please will not create the same release again. Do not move the tag,
delete the release, or unpublish npm as a retry. A defective public package
requires a reviewed correction and a new version.
