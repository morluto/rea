import {
  inspectDebPackageInputSchema,
  debPackageSchema,
} from "../../domain/deb/debPackage.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static Debian package inspection is independent of dpkg, apt, and active native providers. */
export const DEB_PACKAGE_TOOL_CONTRACTS = [
  {
    name: "inspect_deb_package",
    availability: "standalone",
    cli: true,
    ...toolContractMetadata("inspect_deb_package", evidenceEffects),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect a local Debian .deb without installing it, running maintainer scripts, or contacting a mirror. Returns the ar container (magic, members, debian-binary version), control fields (Package, Version with epoch/revision, Architecture, Maintainer, relationships parsed into alternatives with operators and arch qualifiers), conffiles/md5sums presence and counts, maintainer-script interpreter lines and byte lengths, and a bounded data.tar file inventory with an md5sums path cross-check. gzip, zstd, xz, and uncompressed control/data members are decoded in-process; bzip2 and lzma members are unsupported. Missing optional fields stay null, not empty. Malformed or truncated ar/tar input is a typed refusal that retains members already parsed. Package signatures are not verified. Complete Evidence is the result.",
    inputSchema: inspectDebPackageInputSchema,
    outputSchema: evidenceResultOf(debPackageSchema),
    examples: [
      {
        title: "Inspect package identity, dependencies, and file inventory",
        input: { path: "/artifacts/hello_2.03-1_all.deb" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
