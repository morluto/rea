import { nugetPackageSchema } from "../domain/nugetPackage/nugetPackage.js";
import { inspectNugetPackageInputSchema } from "../domain/nugetPackage/nugetPackageQuery.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Named, provider-free contract for the contents of one local NuGet package. */
export const NUGET_PACKAGE_TOOL_CONTRACTS = [
  {
    name: "inspect_nuget_package",
    ...toolContractMetadata("inspect_nuget_package"),
    kind: "application",
    description:
      "Inventory one local NuGet package (.nupkg) offline. The package's .nuspec identity, declared dependency groups and version ranges are reported, together with every archive member's path, declared size, asset kind and target-framework or runtime-identifier folder. NuGet's restore-time asset selection for a target framework is not applied, so a listed asset is not a claim that a consumer receives it. Dependencies are declarations: no restore runs and no feed is contacted. Package contents are never loaded or executed, and signatures are not verified. Every .nuspec member is reported separately rather than one being chosen, malformed or duplicated documents stay explicit diagnostics, and a member path that leaves the package root is refused instead of inventoried. Package metadata is publisher-provided and does not establish that the package is safe. File and member allowances are 64 MiB and 20000.",
    inputSchema: inspectNugetPackageInputSchema,
    outputSchema: evidenceResultOf(nugetPackageSchema),
    examples: [
      {
        title: "Read a supplied package without restoring it",
        input: { path: "/artifacts/Newtonsoft.Json.13.0.3.nupkg" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
