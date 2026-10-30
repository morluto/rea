import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";

import { liveBinaryTargetSummarySchema } from "../../domain/liveBinaryTargetSummary.js";

/** Preserve the admitted target interpretation in public lifecycle results. */
export const binaryTargetSummary = (target: BinaryTarget) => {
  const summary = {
    path: target.path,
    format: target.format,
    kind: target.kind,
    sha256: target.sha256,
    architecture: target.architecture ?? null,
    ...(target.format === "raw-binary" || target.format === "gamecube-dol"
      ? { entry_point: target.entryPoint }
      : {}),
    ...(target.format !== "mach-o" && target.format !== "mach-o-universal"
      ? {}
      : target.debugCompanion === undefined
        ? {}
        : {
            debug_companion: {
              source_path: target.debugCompanion.sourcePath,
              uuid: target.debugCompanion.uuid,
              member_sha256: target.debugCompanion.memberSha256,
            },
          }),
  };
  liveBinaryTargetSummarySchema.parse(summary);
  return summary;
};
