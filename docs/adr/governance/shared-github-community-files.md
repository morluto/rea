# Pilot shared GitHub community files

## Status

Proposed, 2026-11. Maintainers still need to select the owning account and
authorize a pilot. See [the community files proposal](https://github.com/morluto/rea/issues/3448)
and [the organization discussion](https://github.com/morluto/rea/issues/3447).

## Context

GitHub supports default community files from a public `.github` repository
owned by the same personal account or organization as the consuming repository.
A repository's local issue templates and template configuration can override its
shared defaults. GitHub resolves `CODEOWNERS` from the base branch of each
repository. A reusable workflow requires an explicit caller and a callee that
exposes `workflow_call`.
[Default community files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)
· [Code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
· [Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)

Publishing shared defaults under the existing owner can affect every repository
that lacks a local override. REA also has repository-specific contributor
guidance, review expectations, and required CI checks. A pilot needs to
establish which defaults are shared and which repositories would receive them.

## Decision

If maintainers proceed, designate an owner for shared defaults and start in a
separate maintainer-approved test account or organization with two disposable
repositories. One receives a shared default. The other carries a local
override. Use a single issue template and a minimal workflow caller.

1. Publish a sample issue template in the test owner's public `.github`
   repository. Verify the inherited template and local override in the
   new-issue chooser. Repeat with a local issue-template configuration.
2. Keep `CODEOWNERS` in each repository. To test reviewer routing, open
   a pull request against a base branch that already contains that
   repository's `CODEOWNERS` and verify the expected review request.
3. Call one low-risk `workflow_call` workflow from one test repository, pinned
   to a commit SHA. Give the caller only the permissions it needs and pass no
   secrets. Verify success and an intentional failure in Actions and on the
   caller's pull request.
4. Before rollout, inventory repositories under the chosen owner and record
   the local files each already defines. Obtain approval for the exposed
   defaults, callers, and owners. Preserve required check names when migrating
   a production workflow. Keep disclosure policy and release automation under
   their current owners during the pilot.

## Consequences

The pilot verifies inherited defaults, local review routing, and explicit
workflow reuse independently. Rollback consists of removing the pilot defaults
from the test owner and restoring the local workflow in the caller.
A production rollout has a wider effect and needs its own owner, repository
inventory, and rollback plan.
