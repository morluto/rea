# Documentation ownership and authoring

Use the [documentation directory](../README.md) to find existing material before
adding another guide. Preserve one canonical owner for each contract or workflow;
link to that owner instead of copying its claims into several guides.

## Choose a destination

| Document                                                 | Destination                            |
| -------------------------------------------------------- | -------------------------------------- |
| Installation, client setup and first CLI/MCP steps       | `docs/getting-started/`                |
| Analyst workflows and evidence interpretation            | `docs/guides/<domain>/`                |
| Analysis-engine configuration and format prerequisites   | `docs/providers/`                      |
| Shared runtime contracts and evidence semantics          | `docs/reference/`                      |
| Development, testing, release and authoring instructions | `docs/development/`                    |
| Composition diagrams                                     | `docs/architecture/`                   |
| Compatibility changes for a released version             | `docs/migrations/`                     |
| One feature specification, plan and tasks                | `docs/specs/<domain>/<feature-slug>/`  |
| One architectural decision                               | `docs/adr/<domain>/<decision-slug>.md` |

Use meaningful, lowercase domain and feature slugs. Global numeric prefixes are
unnecessary: different domains can add features independently, and branches do
not compete for the next sequence number. Check the existing domain directory
and linked issues before creating a feature with the same slug.

Guides describe existing behavior and limitations. Specs define one proposed
feature or domain change; an existing guide does not become a specification by
moving it into `specs/`.

## Feature lifecycle

Create the specification before implementation. Each feature directory contains:

- `spec.md`: problem, desired behavior, requirements, acceptance and non-goals.
- `plan.md`: the single implementation plan, contracts and architectural choices.
- `tasks.md`: incremental, testable steps linked to requirements and verification.

Split independent domains or separately reviewable features before writing their
specs. A broad `ROADMAP.md`, when useful, only lists child specifications, order
and dependencies; requirements and implementation tasks belong to each child.
Cross-repository contracts have one producer-owned specification. Consumers link
to that contract instead of maintaining competing copies.

Record an isolated architectural decision separately in
`docs/adr/<domain>/<decision-slug>.md`, with **Status**, **Context**,
**Decision** and **Consequences**. Link the ADR from affected specifications.
Do not create decision records for routine file moves or invent past decisions.

Specs do not replace the contribution-scope decision required for a new provider
or expanded execution authority. Follow
[contribution scope](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md#contribution-scope).

## Links and public routes

Use relative links to physical Markdown files so GitHub readers can follow them.
Link repository files outside `docs/` with their full GitHub URLs. Preserve
existing heading anchors when moving a guide.

[`documentation.ts`](https://github.com/morluto/rea/blob/main/docs/.vitepress/documentation.ts)
owns categorized site navigation and the existing guides' stable public routes.
Update it when adding or moving a guide. VitePress rewrites categorized sources
to the existing public paths; its Markdown hook resolves repository links from
the physical source and renders them against those public routes. Keep basenames
and route assignments unique. Edit links use the physical source file.

For a move, search for both the basename and its old full path. Update README
translations, authored skills, verification instructions, documentation-fact
readers and release configuration when they consume that path. Preserve
historical release records and references bound to earlier commits or tags.

## Generated ownership and checks

The [documentation directory](../README.md#machine-owned-documentation) identifies
the machine-owned outputs and their producers. Their existing paths are retained
because scripts, package consumers and release history depend on them. Change
canonical sources and regenerate; do not fix a generated projection by hand.

Run `npm run docs:check` for documentation facts and generated consistency, and
`npm run verify:docs:routes` to build the complete production site and check local
links, anchors and physical edit targets.
When a physical path moves, also run the tests that read it. Follow
[development checks](testing.md#developer-commands) before requesting review.
