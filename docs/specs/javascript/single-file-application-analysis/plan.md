# Implementation plan

## Boundary and contract

Extend `javaScriptApplicationInputFormatSchema` (`"auto" | "asar" | "directory" | "file"`)
and `javaScriptApplicationFormatSchema` (`"asar" | "directory" | "file"`) in
`src/domain/javascript/javascriptApplicationAnalysis.ts`, propagating `"file"` to
`src/domain/analysisView/analysisViewResult.ts`,
`src/domain/javascript/javascriptRuntimeReconciliationSchemas.ts`,
`src/cli/electronCommands.ts`, and
`src/contracts/javascript/electronToolContracts.ts`.

Add `isJavaScriptSourcePath` to `artifactNameForClassification` in
`src/domain/artifactNameSelection.ts` so symlinked TypeScript and JSX aliases
retain source-extension classification without altering `namedArtifactFormat`.
Implement `SingleFileJavaScriptArtifactReader` in
`src/artifacts/javascript/JavaScriptArtifactReader.ts` over `ArtifactFileSource`,
`assertArtifactSelectedSource`, and `readArtifactFileChunks`, project the single
root occurrence to its normalized basename in
`src/artifacts/javascript/JavaScriptArtifactFiles.ts`, and verify
`snapshot.manifest.root_format === "javascript-bundle"` in
`src/application/javascript/JavaScriptArtifactReconstruction.ts`.

Extend `mappedRuntimePaths` and `exercisedArtifactPrefixes` in
`src/domain/javascript/javascriptRuntimeStaticCandidates.ts` so `format === "file"`
layers map exact runtime script paths to the single inventoried artifact path
without widening `artifactPrefix` to sibling files.

## Incremental work and validation

1. Extend input/output format schemas, CLI flags, and MCP contracts with `"file"`.
2. Implement `SingleFileJavaScriptArtifactReader`, root-occurrence basename
   projection, symlinked `.jsx`/`.ts`/`.tsx`/`.mts`/`.cts` classification, and
   `"javascript-bundle"` root-format verification.
3. Add exact single-file path mapping to `javascriptRuntimeStaticCandidates.ts`
   while keeping sibling scripts outside automatic scope.
4. Link boundary, CLI, MCP, and runtime-reconciliation tests to requirements and
   update the [JavaScript artifact reconstruction guide](../../../guides/javascript/javascript-artifact-reconstruction.md)
   and [JavaScript static/runtime reconciliation guide](../../../guides/javascript/javascript-runtime-reconciliation.md).

## Effects and compatibility

Existing directory and `.asar` analysis outputs and `evidence_id` digests are
unchanged. `"file"` appears only when analyzing an admitted single-file target,
and disguised native binaries continue failing closed before source parsing.
