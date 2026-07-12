# Contributing to REA

REA welcomes focused bug fixes, documentation improvements, tests, and reverse-engineering workflow enhancements. Open an issue before a large contract or architecture change so its scope can be agreed before implementation.

## Development setup

REA requires macOS 12 or newer, Node.js 22 or newer, and a separately installed Hopper Disassembler application for real-Hopper verification.

```bash
npm ci
npm run build
npm test
```

Keep dependencies flowing inward through the existing domain, Hopper, application, server, and adapter layers. Parse unknown values at process and protocol boundaries, model expected failures with `Result`, and preserve the 31 direct, 8 enhanced, and 3 session tools unless a deliberate contract change updates every verifier and snapshot.

Before submitting a pull request, run:

```bash
npm run check
npm run verify:package
npm pack --dry-run
```

Changes that claim real Hopper behavior must also be tested against two distinct binaries:

```bash
HOPPER_TARGET_PATH=/path/to/target-a \
HOPPER_SECOND_TARGET_PATH=/path/to/distinct-target-b \
npm run verify:hopper
```

Describe the behavior change and verification performed in the pull request. Never commit binaries, Hopper documents, credentials, `dist/`, `node_modules/`, or local planning artifacts.

## Maintainer release checklist

Run the full checks, isolated package verifier, package dry run, and two-target real-Hopper verifier described above. Build a local tarball and exercise the executable through the package boundary:

```bash
npm pack
npm exec --yes --package ./morluto-rea-0.1.0.tgz -- rea --help
```

Publish the public scoped package:

```bash
npm publish --access public
```

After npm registry propagation, verify the published CLI and connect a beta.3 MCP client to the published server to confirm all 42 tools:

```bash
npx -y @morluto/rea --help
npx -y @morluto/rea doctor
npx -y @morluto/rea setup --yes
npx -y @morluto/rea mcp
```
