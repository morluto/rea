# Implementation plan

## Layout and ownership

Keep `docs/index.md` as the website landing page. Group authored documents under
`getting-started/`, `guides/<domain>/`, `providers/`, `reference/`,
`development/` and `migrations/`. Keep the architecture map under
`architecture/`. Add a linked directory describing every category and its files.

Leave `assets/`, `public/`, `verification/`, `releases/`,
`error-contract.schema.json` and `user-visible-errors.csv` at their owned paths.
The schema generator and catalog/evidence writers retain their current contracts.
No root document is converted into a feature specification merely to fit a folder.

## Link and route contracts

Preserve moved basenames. Convert local Markdown links using each document's old
and new location, including links to assets and generated references. Update
literal physical paths in documentation checks, release tooling and tests.
VitePress rewrites map categorized Markdown sources to their original root route,
so existing public guide links and anchors remain available. Site navigation
continues using public routes; edit links use the actual source path.

Keep the independent native/Pascal work in PR #2400 mergeable by limiting changes
to required links in its moved guide. The EVM guide follows the same rule.

## Verification

Run documentation-fact checks and the affected README, release and filesystem
boundary tests. Build the complete VitePress site with dead-link checks enabled,
then compare emitted HTML routes with the pre-migration guide inventory. Inspect
the diff for unintended text rewrites and retained generated ownership. Run the
repository static checks before requesting review.

Keep a reproducible built-HTML verifier with an independent 58-route baseline,
including the new upstream signal guide. Verify physical edit targets, local
published files/images and fragment IDs rather than treating a successful build
as sufficient link verification. Normalize references to docs/public at the
renderer boundary, where VitePress publishes them at the site root. Preserve a
legacy managed/native fragment alias while retaining the existing heading.
Run this verification in documentation CI and the manual documentation build.
Changes to the verifier itself must select the documentation lane; cover this
using the actual CI planner against an isolated Git fixture.
