# Tasks

- [x] Define the single-feature scope, contract, limits and plan.
- [x] Parse the XAR header, zlib TOC, Distribution/PackageInfo and gzip odc
      cpio Scripts/Payload members with synthetic fixtures and budgets.
- [x] Register the portable `pkg` reader, format metadata and honest
      limitation; cover malformed refusals and lifecycle.
- [x] Add CLI acceptance and MCP `inspect_artifact` / `extract_artifact`
      tests.
- [x] Document the workflow in `docs/macos-pkg.md` and the authored skill.
- [x] Inventory a public MacPorts 2.10.5 Sequoia installer through
      `inspect-artifact`.
- [ ] Verify against a locally produced `pkgbuild`/`productbuild` package;
      verify XAR signatures; decode pbzx/xz and Bom.
