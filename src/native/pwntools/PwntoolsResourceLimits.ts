import { join } from "node:path";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import {
  PWNTOOLS_MEMORY_FAILURE_EXIT,
  PWNTOOLS_FILE_SIZE_FAILURE_EXIT,
} from "./PwntoolsRelease.js";
import { z } from "zod";
import { PWNTOOLS_LIMITS } from "./PwntoolsRelease.js";

/** Actual limits reported by the owned bridge after lowering inherited soft limits. */
export const pwntoolsResourceLimitsSchema = z.strictObject({
  address_space_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(PWNTOOLS_LIMITS.addressSpaceBytes),
  cpu_seconds: z.number().int().nonnegative().max(PWNTOOLS_LIMITS.cpuSeconds),
  file_size_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(PWNTOOLS_LIMITS.outputBytes),
});

/** A missing or invalid report leaves limits unknown and retains its read failure. */
export interface PwntoolsLimitReport {
  readonly limits: z.output<typeof pwntoolsResourceLimitsSchema> | null;
  readonly failure: string | null;
}

/** Private failure-branch evidence; a bare launcher exit code is insufficient. */
export interface PwntoolsFailureEvidence {
  readonly limits?: PwntoolsLimitReport;
  readonly marker?: {
    readonly resource: "memory" | "file-size" | null;
    readonly failure: string | null;
  };
}

/** Read only bounded owned reports; unverified reserved statuses stay unclassified. */
export const readPwntoolsFailureEvidence = async (
  cause: unknown,
  rootPath?: string,
): Promise<PwntoolsFailureEvidence> => {
  let limitReport: PwntoolsLimitReport | undefined;
  let marker: PwntoolsFailureEvidence["marker"];
  if (
    cause instanceof OwnedCommandFailure &&
    cause.snapshot?.signal === null &&
    (cause.snapshot.exitCode === PWNTOOLS_MEMORY_FAILURE_EXIT ||
      cause.snapshot.exitCode === PWNTOOLS_FILE_SIZE_FAILURE_EXIT) &&
    rootPath !== undefined
  ) {
    try {
      const reported = await readStableArtifact(
        join(rootPath, "resource.failure"),
        1,
      );
      const expected =
        cause.snapshot.exitCode === PWNTOOLS_MEMORY_FAILURE_EXIT ? "M" : "F";
      if (!reported.bytes.equals(Buffer.from(expected, "ascii")))
        throw new Error(
          "Private bridge failure marker does not match the observed exit status.",
        );
      marker = {
        resource: expected === "M" ? "memory" : "file-size",
        failure: null,
      };
    } catch (markerFailure: unknown) {
      marker = {
        resource: null,
        failure:
          markerFailure instanceof Error
            ? markerFailure.message
            : String(markerFailure),
      };
    }
  }
  if (
    cause instanceof OwnedCommandFailure &&
    (cause.snapshot?.signal === "SIGXCPU" ||
      cause.snapshot?.signal === "SIGXFSZ" ||
      ((cause.snapshot?.exitCode === PWNTOOLS_FILE_SIZE_FAILURE_EXIT ||
        cause.snapshot?.exitCode === PWNTOOLS_MEMORY_FAILURE_EXIT) &&
        cause.snapshot.signal === null)) &&
    rootPath !== undefined
  ) {
    try {
      const reported = await readStableArtifact(
        join(rootPath, "limits.json"),
        4096,
      );
      limitReport = {
        limits: pwntoolsResourceLimitsSchema.parse(
          JSON.parse(reported.bytes.toString("utf8")),
        ),
        failure: null,
      };
    } catch (reportFailure: unknown) {
      limitReport = {
        limits: null,
        failure:
          reportFailure instanceof Error
            ? reportFailure.message
            : String(reportFailure),
      };
    }
  }
  return {
    ...(limitReport === undefined ? {} : { limits: limitReport }),
    ...(marker === undefined ? {} : { marker }),
  };
};
