import type {
  BinaryTarget,
  RawBinaryLoad,
} from "../../domain/binaryTargetTypes.js";

import { liveBinaryTargetSummarySchema } from "../../domain/liveBinaryTargetSummary.js";
import { isLegacyRawLoad } from "../../domain/rawBinary.js";

/** A legacy-equivalent load reports only its entry, exactly as before. */
const rawLoadSummary = (load: RawBinaryLoad) => ({
  entry_point: load.entryPoint,
  ...(isLegacyRawLoad(load)
    ? {}
    : {
        base_address: load.baseAddress,
        ...(load.architectureVariant === undefined
          ? {}
          : { architecture_variant: load.architectureVariant }),
        ...(load.entrySource.kind === "vector-table"
          ? { vector_table_address: load.entrySource.address }
          : {}),
      }),
});

/** Preserve the admitted target interpretation in public lifecycle results. */
export const binaryTargetSummary = (target: BinaryTarget) =>
  liveBinaryTargetSummarySchema.parse({
    path: target.path,
    format: target.format,
    kind: target.kind,
    sha256: target.sha256,
    architecture: target.architecture ?? null,
    ...(target.format === "raw-binary"
      ? rawLoadSummary(target.rawLoad)
      : target.format === "gamecube-dol"
        ? { entry_point: target.entryPoint }
        : {}),
  });
