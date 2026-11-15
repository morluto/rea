import {
  inspectRpmPackageInputSchema,
  rpmPackageSchema,
} from "../../domain/rpm/package.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static RPM inspection is independent of rpm/dnf install and active native providers. */
export const RPM_PACKAGE_TOOL_CONTRACTS = [
  {
    name: "inspect_rpm_package",
    availability: "standalone",
    cli: true,
    ...toolContractMetadata("inspect_rpm_package", evidenceEffects),
    kind: "artifact-provider",
    description:
      "Inspect a local RPM package's lead, signature header and main header without installing it, running scriptlets, verifying signatures, or decompressing the payload. Returns lead identity (magic, version, binary/source type, arch/os numbers, name), signature header digests and whether GPG/RSA/DSA blobs are present with trivially decoded algorithm/key-id bytes, main-header NEVRA/license/payload compressor fields, dependency sets with rendered comparison flags, scriptlet presence and byte length (source text only when include_script_text is true), and a header file inventory. Missing optional tags stay null, not empty or zero. File listing comes from header tags; payload offset/size and declared compressor are reported without unpacking cpio. Malformed or truncated headers fail with typed refusals that keep safely read lead/header facts. Complete Evidence is the result.",
    inputSchema: inspectRpmPackageInputSchema,
    outputSchema: evidenceResultOf(rpmPackageSchema),
    examples: [
      {
        title: "Inspect package identity, dependencies and header files",
        input: { path: "/artifacts/demo-1.0.0-1.noarch.rpm" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
