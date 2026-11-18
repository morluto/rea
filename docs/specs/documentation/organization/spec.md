# Documentation organization

## Problem and outcome

The authored documentation root mixes user workflows, provider setup, contracts,
development instructions and release migrations. Several existing guides are
missing from site navigation. A contributor needs one documented destination for
each kind of document without breaking reader links or automated path consumers.

Tracking issue: <https://github.com/morluto/rea/issues/2401>.

## Requirements

1. Categorize every existing authored guide while preserving its basename,
   substantive content and heading anchors.
2. Preserve existing public guide URLs; update physical repository links and
   tests, release instructions and documentation-fact readers together.
3. Expose every existing guide through a documentation directory and categorized
   site navigation.
4. Specify one feature/domain per `docs/specs/<domain>/<feature-slug>/`, with `spec.md`,
   exactly one `plan.md` and `tasks.md`. Broad specification roadmaps only list
   child specifications, order and dependencies. Architectural decisions use
   individual Michael Nygard ADRs under `docs/adr/<domain>/<decision-slug>.md`.
5. Preserve machine-owned catalog, evidence, schema and release-manifest paths;
   explain their owners and regeneration commands separately from authored guides.

## Acceptance

- Every pre-existing authored Markdown guide has a categorized destination.
- All local Markdown file references resolve after migration.
- A production VitePress build emits all pre-existing guide routes.
- Documentation facts and relevant physical-path consumer tests pass.
- The organization has one implementation plan and incremental task list.

## Out of scope

Provider integration, runtime behavior, analysis contracts, new language support,
rewriting guide claims, deployment and generated-output ownership changes.
