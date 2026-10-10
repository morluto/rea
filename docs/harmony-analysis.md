# Static HarmonyOS package inventory

REA inventories HarmonyOS application packages through the shared hardened
ZIP artifact reader in `src/artifacts/`, then projects the authenticated
inventory into an execution-free application graph. This is the first
increment of the HarmonyOS roadmap (#1431): package identification and
component inventory only.

Recognized root formats:

- `.hap` — installable application module
- `.hsp` — runtime shared package
- `.app` — distribution App Pack (HAP/HSP children are listed by path). The
  App Pack classification applies to verified-ZIP-magic root inputs only; a
  nested ZIP member ending in `.app` inside another package, such as an IPA,
  keeps the generic `zip` classification.

HarmonyOS `.har` shared libraries are intentionally not classified by suffix:
`.har` also names HTTP Archive JSON, so a Harmony shared archive requires
verified ZIP bytes and is deferred with an explicit limitation.

## Usage

No external SDK, toolchain, or engine is required. Inventory the package and
project the graph; CLI and MCP use the same workflow and return
artifact-bound Evidence inline:

```sh
rea inspect-artifact /path/to/Example.hap > inspection.json
rea project-harmony-application-graph inspection.json
```

The MCP tool `project_harmony_application_graph` takes the same
`inventory_evidence` input. The projection reports:

- exact component paths, artifact IDs, and hashes (manifests, Ark bytecode,
  resources, native libraries, JavaScript, signing)
- a packaging-model hint: Stage is claimed only from a `module.json` entry,
  FA only from `config.json`, otherwise `unknown`
- App Pack child package paths without recursive inventory
- runtime-family hints (`ark`, `native`, `javascript`) from paths and formats
- path-based N-API bridge hypotheses between bytecode and `libs/<abi>` native
  libraries

Every claim is path-presence only. Manifest semantics (module identity,
abilities, entry points, permissions, dependencies), Ark bytecode contents and
versions, resource resolution, signing verification, and observed native
boundaries are out of scope for this increment and stay in the projection's
`limitations` array until a dedicated HarmonyOS provider exists. REA fails
closed on packages whose inventory cannot be authenticated.

## Verification lane

`npm run fixtures:harmony` downloads the pinned VHome 2.6.14-beta unsigned
HAP release (a real Stage-model package produced by the official OpenHarmony
toolchain) with SHA-256 verification into `_reference/harmony-integration/`.
The upstream project declares no license, so the fixture is downloaded at
verification time and never redistributed. The upstream repository rotates
and replaces release assets; a SHA-256 mismatch means the pin must be
re-examined against the current upstream asset, not retried.

```sh
npm run fixtures:harmony
REA_HARMONY_TEST_HAP=_reference/harmony-integration/VHome-2.6.14-beta-unsigned.hap \
  npm run verify:harmony
```

The lane exercises the compiled CLI and a stdio MCP server against the real
package: `inspect_artifact` authenticity, projection determinism, Stage-model
classification, exact bytecode/native-library/resource component sets, the
unsigned-build signing boundary, N-API bridge hypotheses, complete-inventory
coverage, and CLI/MCP result parity. The pinned package is an unsigned build,
so the lane asserts the signing component is empty; an empty signing list
never means a package is unsigned, because packaging-tool signatures live in
the ZIP signing block rather than archive entries.
