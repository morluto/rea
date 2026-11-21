import {
  inspectVsixPackageInputSchema,
  vsixPackageSchema,
} from "../../domain/vsix/vsixPackage.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static VS Code extension package inspection is independent of install and marketplaces. */
export const VSIX_PACKAGE_TOOL_CONTRACTS = [
  {
    name: "inspect_vsix_package",
    availability: "standalone",
    cli: true,
    ...toolContractMetadata("inspect_vsix_package", evidenceEffects),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect a local VS Code .vsix ZIP without installing, executing, or contacting a marketplace. Returns package identity from extension.vsixmanifest and extension/package.json with any disagreement, engine range, target platform, entry points and whether each resolves to a member, activation events (with * and onStartupFinished flagged as eager), a contributes summary, declared dependencies and pack members, untrusted/virtual workspace capabilities, API proposals, assets, a ZIP inventory with counts by kind, hashed native addons/wasm/executables/shell scripts/nested archives, and signature-file presence. Missing or malformed manifests succeed with inventory and explicit limitations. Encrypted members are listed and not extracted. Invalid ZIP input fails without partial success. Signature files are reported present or absent and are not verified. Complete Evidence is the result.",
    inputSchema: inspectVsixPackageInputSchema,
    outputSchema: evidenceResultOf(vsixPackageSchema),
    examples: [
      {
        title: "Inspect extension identity and activation events",
        input: { path: "/artifacts/demo.hello-1.2.3.vsix" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
