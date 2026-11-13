import {
  inspectNugetNupkgInputSchema,
  nugetNupkgSchema,
} from "../../domain/nuget/nupkg.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static NuGet package inspection is independent of restore, feeds, and active native providers. */
export const NUGET_NUPKG_TOOL_CONTRACTS = [
  {
    name: "inspect_nuget_nupkg",
    ...toolContractMetadata("inspect_nuget_nupkg"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect a local NuGet .nupkg ZIP without restoring, executing, or contacting a feed. Returns package identity (id, version, authors, description), license and repository fields as present in the .nuspec, dependency groups with target frameworks and version ranges, and a ZIP contents inventory (entry names, sizes, encrypted flag, path-derived folder roles). Missing, ambiguous, or malformed .nuspec members succeed with inventory and explicit limitations. Encrypted members are listed and not extracted. Invalid ZIP input fails without partial success. Member roles are folder conventions, not restore-time asset selection. Complete Evidence is the result.",
    inputSchema: inspectNugetNupkgInputSchema,
    outputSchema: evidenceResultOf(nugetNupkgSchema),
    examples: [
      {
        title: "Inspect package identity and dependency groups",
        input: { path: "/artifacts/Demo.Package.1.2.3.nupkg" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
