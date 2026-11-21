# Documentation ownership and authoring

Use the [documentation directory](../README.md) to find existing material before
adding another guide. Preserve one canonical owner for each contract or workflow;
link to that owner instead of copying its claims into several guides.

When a contract changes, update its owning page with the implementation. Check
the examples and recovery steps in related guides against the supported CLI
and MCP entry points. Link guides to the section that owns the shared behavior
so readers can reach it from the task they are performing.

## Choose a destination

| Document                                                 | Destination             |
| -------------------------------------------------------- | ----------------------- |
| Installation, client setup and first CLI/MCP steps       | `docs/getting-started/` |
| Analyst workflows and evidence interpretation            | `docs/guides/<domain>/` |
| Analysis-engine configuration and format prerequisites   | `docs/providers/`       |
| Shared runtime contracts and evidence semantics          | `docs/reference/`       |
| Development, testing, release and authoring instructions | `docs/development/`     |
| Compatibility changes for a released version             | `docs/migrations/`      |

Use meaningful, lowercase slugs. Guides describe current workflows, behavior and
limitations. Ground their claims in the implementation and verify examples
through the supported entry points.

Follow the [repository guidance on where to keep planning and architecture records](https://github.com/morluto/rea/blob/main/AGENTS.md#development)
and the
[contribution scope](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md#contribution-scope)
for proposals that require a maintainer decision.

## Links and public routes

Use relative links to physical Markdown files so GitHub readers can follow them.
Link repository files outside `docs/` with their full GitHub URLs. Preserve
existing heading anchors when moving a guide.

[`documentation.ts`](https://github.com/morluto/rea/blob/main/docs/.vitepress/documentation.ts)
owns categorized site navigation and the existing guides' stable public routes.
Update it and the [documentation directory](../README.md) when adding or
recategorizing a guide. VitePress rewrites categorized sources
to the existing public paths; its Markdown hook resolves repository links from
the physical source and renders them against those public routes. Keep basenames
and route assignments unique. Edit links use the physical source file.

For a move, search for both the basename and its old full path. Update README
translations, authored skills, verification instructions, documentation-fact
readers and release configuration when they consume that path. Preserve
historical release records and references bound to earlier commits or tags.

## Generated ownership and checks

The [documentation directory](../README.md#generated-files-and-release-records) lists
generated files, their producers, and release records. Scripts, package
consumers, and release history depend on the listed paths. Update the producer
or its inputs and regenerate.

Do not write the number of tools in living prose; link the generated catalog
instead. `docs:check` refuses a count of ten or more tools outside dated
records (`docs/releases/` and `docs/verification/`).

Run `npm run docs:check` for documentation facts and generated consistency, and
`npm run verify:docs:routes` to build the complete production site and check local
links, anchors and physical edit targets.
When a physical path moves, also run the tests that read it. Follow
[development checks](testing.md#developer-commands) before requesting review.
