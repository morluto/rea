# Electron and Node native-addon loader recovery

## Problem and outcome

`analyze_javascript_application` and `trace_application_feature` previously
recognized native-addon bindings only when JavaScript source passed a direct
static `.node` string literal into `import`, `export`, or `require(...)`.
Packaged Electron and Node.js applications commonly load `.node` binaries
through `node-gyp-build`, `bindings`, `process.dlopen`, source-anchored
`.replace("app.asar", "app.asar.unpacked")` rewrites, and host-platform/arch
path expressions (`process.platform`, `process.arch`, `os.platform()`,
`os.arch()`), leaving `summary.native_addon_bindings`,
`summary.resolved_native_addon_bindings`, and `trace_application_feature`
`native_handoffs` at `0`.

Extend inert JavaScript/Electron static analysis and artifact-confined boundary
resolution to recover these standard native-addon loader idioms and project
resolved `.node` targets into `JavaScriptApplicationGraph` and
`trace_application_feature`, including post-pack code-signed
`app.asar.unpacked` companions analyzed under
`integrity_policy: "record-and-continue"`.

## Requirements

- Prove module provenance for `node-gyp-build` and `bindings`, unmodified global
  or `node:process` provenance for `process.dlopen`, and read-only `node:os`
  provenance for `os.platform()` / `os.arch()` without executing target code or
  misclassifying shadowed or reassigned local bindings.
- Recover native-addon bindings at `VariableDeclarator`, CommonJS export
  assignments, lexical variable assignments (`=`, `??=`, `||=`),
  `ReturnStatement`, concise `ArrowFunctionExpression`, and standalone
  `process.dlopen(...)` calls, distinguishing `process.dlopen(module, ...)` from
  custom `{ exports: {} }` holder objects.
- Support `import.meta.dirname` and `import.meta.filename` path intrinsics and
  source-anchored `.replace("app.asar", "app.asar.unpacked")` directory or file
  path rewrites.
- Expand bounded `.node` path templates across proven host axes
  (`{darwin, linux, win32}` × `{arm64, x64, ia32}`), and record unresolved or
  dynamic native loader arguments in `unknown_findings` rather than guessing.
- Confine candidate `.node` resolution strictly to inventoried `native-addon`
  entries within the analyzed artifact and enclosing package boundary (excluding
  nested `node_modules/` packages, `.node.js` files, and unanchored absolute
  filesystem paths).
- Project `addon --[exposes]--> native-export` and, when no direct static
  `loads` module-reference edge already exists, `source --[loads]--> addon` into
  `JavaScriptApplicationGraph` with `evidence_sources: ["ast-inference"]`,
  `confidence: "medium"`, `resolved_paths` when multiple platform prebuilds
  match, and preserved `observed-untrusted` `integrity_contradictions` under
  `integrity_policy: "record-and-continue"`.

## Acceptance

Unit and filesystem/ASAR boundary tests verify `node-gyp-build` (CommonJS, ESM,
lazy getters, `.asar.unpacked` rewrites), `bindings` (string and options-object
forms), `process.dlopen` (`module` vs custom holder), host-axis `.node`
expansion across `require` and `createRequire`, negative shadowing/mutation
guards, `.node.js` and nested `node_modules/` exclusion, `trace_application_feature`
`native_handoffs` correlation with native `Evidence`, and `integrity_policy`
(`fail` vs `record-and-continue`) contradiction preservation.

## Out of scope

Executing target JavaScript or native binaries, modifying ASAR inventory or
`integrity_policy` trust rules, or speculating on arbitrary environment-variable
or unanchored host-filesystem `.node` paths.
