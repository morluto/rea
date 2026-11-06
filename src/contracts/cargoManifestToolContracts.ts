import { cargoManifestSchema } from "../domain/cargoManifest/cargoManifest.js";
import { inspectCargoManifestInputSchema } from "../domain/cargoManifest/cargoManifestQuery.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Named, provider-free contract for declarations in one local Cargo manifest. */
export const CARGO_MANIFEST_TOOL_CONTRACTS = [
  {
    name: "inspect_cargo_manifest",
    ...toolContractMetadata("inspect_cargo_manifest"),
    kind: "application",
    description:
      "Inventory declared packages, dependencies, targets and features in one local Cargo.toml offline. Cargo, build scripts, proc macros and dependency code stay untouched; there is no registry or network access and no lockfile resolution. Registry, Git, path and workspace-inherited dependencies stay distinct, aliases keep the manifest key apart from the package name, and target-specific tables retain their condition. Malformed declarations remain explicit diagnostics instead of being flattened. Workspace member manifests and Cargo.lock are not read, so cross-manifest reconciliation and resolved versions remain unanalyzed. File and retained-facts allowances are each 32 MiB.",
    inputSchema: inspectCargoManifestInputSchema,
    outputSchema: evidenceResultOf(cargoManifestSchema),
    examples: [
      {
        title: "Read a manifest's declared dependencies without building it",
        input: { path: "/artifacts/Cargo.toml" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
