# Tasks

- [x] Define single-feature scope, contracts and implementation plan (`spec.md`, `plan.md`).
- [x] Register `deno-standalone` in the artifact format, inventory, extraction, domain and tool contract owners.
- [x] Implement carrier location for Mach-O sections, Intel trailers, ELF notes and PE resources in `src/artifacts/deno/DenoStandaloneLocation.ts`.
- [x] Implement bounded section parsing and the virtual-filesystem walk with indexed and percent-encoded logical paths.
- [x] Retain environment-file values and CA bytes in local Evidence with inventory limitations, and keep them out of extraction.
- [x] Add synthetic layout, location, virtual-filesystem and reader tests, CLI acceptance, filesystem boundary and MCP boundary tests.
- [x] Verify real Deno 2.9.8 host and cross-target compiles with `npm run verify:deno:standalone` ([record](../../../verification/deno-standalone-2026-10-31.md)).
- [x] Update the usage guide, CLI guide, limits, READMEs and skill references; pass documentation checks.
