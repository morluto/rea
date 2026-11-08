# Implementation plan

## Boundary and contract

Add static native-addon loader provenance and candidate extraction in
`src/domain/javascript/electronNativeAddonLoaders.ts` and wire it through
`src/domain/javascript/electronStaticAnalysisNative.ts`,
`src/domain/javascript/electronStaticAnalysisTypes.ts`,
`src/domain/javascript/javascriptApplicationProjectionResources.ts`, and
`src/javascript/analysis/JavaScriptAnalysisWorkerSchemas.ts`. Extend path
intrinsic and builtin receiver helpers (`javascriptStaticAnalysisHelpers.ts`,
`javascriptSemanticGlobalReference.ts`, `javascriptStaticPathIntrinsics.ts`,
`javascriptSemanticDataEffectHelpers.ts`, `javascriptSemanticAmbientWrites.ts`)
to recognize `import.meta.dirname` / `import.meta.filename` and read-only
`os.platform()` / `os.arch()` calls.

Add artifact-confined `.node` target resolution in
`src/application/javascript/ElectronBoundaryNativeResolution.ts` and integrate
it into `src/application/javascript/ElectronBoundaryAnalysis.ts` and
`src/application/javascript/ElectronBoundaryGraphNative.ts` so resolved helper
loaders populate `summary.native_addon_bindings`,
`summary.resolved_native_addon_bindings`, `native-export` (`resolved_path` /
`resolved_paths`), `associate-native-addon-load` `loads` edges, and
`trace_application_feature` `native_handoffs`.

## Incremental work and validation

1. Implement AST/semantic loader detection (`node-gyp-build`, `bindings`,
   `process.dlopen`, `.asar.unpacked` rewrites, bounded platform/arch `.node`
   expansion) and worker schema validation.
2. Implement package-confined `.node` candidate resolution across directory and
   ASAR + `.asar.unpacked` inventories and project `loads` / `exposes` graph
   edges without duplicating direct static module references.
3. Add unit tests (`src/domain/javascript/electronNativeAddonLoaders.test.ts`)
   and filesystem/ASAR boundary tests
   (`tests/boundary/filesystem/javascript-applications/electronNativeAddonLoaders.test.ts`).
4. Update the [JavaScript artifact reconstruction guide](../../../guides/javascript/javascript-artifact-reconstruction.md)
   and feature specification index; pass formatting, static, typed-lint, test,
   and documentation checks.

## Effects and compatibility

No new CLI commands or MCP tools are added. Existing `analyze_javascript_application`
and `trace_application_feature` contracts gain additive `resolved_paths`
observations on multi-prebuild `native-export` nodes while preserving strict
default ASAR integrity failures and `observed-untrusted` contradiction reporting
under `integrity_policy: "record-and-continue"`.
