import { GhidraAdmissionError } from "./GhidraAdmissionError.js";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import type { AnalysisOperation } from "../ports/AnalysisProvider.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import {
  readGhidraProfileArtifact,
  writeGhidraProfileArtifact,
  ghidraFileFailure,
} from "./GhidraFileArtifacts.js";
import { NonRegularFileReadError } from "../filesystem/RegularFile.js";
import { err, ok, type Result } from "../domain/result.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import {
  MAX_GHIDRA_SEED_BYTES,
  normalizedGhidraSeeds,
  parseGhidraSeeds,
  ghidraSeedLineError,
  type GhidraSeedEntry,
} from "../domain/native/ghidraSeedFile.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

/** Seed file format admitted by this adapter. */
export const GHIDRA_SEED_FORMAT = "rea-ghidra-seeds-v1";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.int().nonnegative();

/** Caller-declared seeds committed into the analysis profile before import. */
export const ghidraSeedCommitmentSchema = z.strictObject({
  format: z.literal(GHIDRA_SEED_FORMAT),
  path: z.string().refine(isAbsolute, "Seed path must be absolute"),
  configured_path: z.string().refine(isAbsolute, "Seed path must be absolute"),
  sha256: digest,
  entries: z.strictObject({ function: count, code: count, label: count }),
});
export type GhidraSeedCommitment = z.infer<typeof ghidraSeedCommitmentSchema>;

/** What the pre-analysis script applied, as reported by the bridge handshake. */
export const ghidraSeedReportSchema = z
  .strictObject({
    format: z.literal(GHIDRA_SEED_FORMAT),
    sha256: digest,
    entries: count,
    function_created: count,
    function_existing: count,
    function_failed: count,
    code_decoded: count,
    code_failed: count,
    label_applied: count,
    label_failed: count,
    unmapped: count,
  })
  .refine(
    (report) =>
      report.function_created +
        report.function_existing +
        report.function_failed +
        report.code_decoded +
        report.code_failed +
        report.label_applied +
        report.label_failed +
        report.unmapped ===
      report.entries,
    { message: "Seed outcomes must account for exactly the reported entries." },
  );
export type GhidraSeedReport = z.infer<typeof ghidraSeedReportSchema>;

/** Parse seed facts before final close so later cleanup cannot replace invalid input. */
const readSeeds = (
  path: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<readonly GhidraSeedEntry[]> =>
  readGhidraProfileArtifact(
    path,
    MAX_GHIDRA_SEED_BYTES,
    resources,
    signal,
    (bytes) => {
      let text: string;
      try {
        // A user-authored seed file may start with a BOM signature.
        text = decodeStrictUtf8(bytes, "strip-signature");
      } catch {
        throw ghidraSeedLineError(0, "file is not valid UTF-8");
      }
      const parsed = parseGhidraSeeds(text);
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    },
  );

/** Preserve native lookup semantics while allowing configured symbolic links. */
const resolveSeedPath = async (configured: string): Promise<string> => {
  // Darwin realpath may collapse file/.. even though native lookup rejects it.
  const selected = await stat(configured);
  if (!selected.isFile())
    throw new NonRegularFileReadError(configured, selected.isDirectory());
  return realpath(configured);
};

/** Resolve the configured seed file into an immutable profile commitment. */
export const resolveGhidraAnalysisSeeds = async (
  configured: string | undefined,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<GhidraSeedCommitment | undefined, AnalysisError>> =>
  resources
    .run(async () => {
      if (configured === undefined) return ok(undefined);
      let entries: readonly GhidraSeedEntry[];
      let path: string;
      try {
        path = await resolveSeedPath(configured);
        entries = await readSeeds(path, resources, signal);
      } catch (cause: unknown) {
        return err(
          ghidraFileFailure(cause, "resolve_analysis_profile", {
            setting: "REA_GHIDRA_SEED_FILE",
            path: configured,
          }),
        );
      }
      const normalized = normalizedGhidraSeeds(entries);
      const tally = { function: 0, code: 0, label: 0 };
      for (const entry of entries) tally[entry.kind] += 1;
      return ok<GhidraSeedCommitment>({
        format: GHIDRA_SEED_FORMAT,
        path,
        configured_path: configured,
        sha256: sha256Hex(normalized),
        entries: tally,
      });
    })
    .catch((cause: unknown) =>
      err(
        ghidraFileFailure(cause, "resolve_analysis_profile", {
          setting: "REA_GHIDRA_SEED_FILE",
        }),
      ),
    );

/** Re-read the committed seeds and write the canonical copy the script applies. */
export const snapshotGhidraAnalysisSeeds = async (
  commitment: GhidraSeedCommitment,
  runtimeRoot: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<string> =>
  resources
    .run(async () => {
      ghidraSeedCommitmentSchema.parse(commitment);
      if (
        (await resolveSeedPath(commitment.configured_path)) !== commitment.path
      )
        throw new GhidraAdmissionError("seed_path_differs");
      const entries = await readSeeds(commitment.path, resources, signal);
      const normalized = normalizedGhidraSeeds(entries);
      if (sha256Hex(normalized) !== commitment.sha256)
        throw new GhidraAdmissionError("seed_changed", {
          path: commitment.path,
        });
      const directory = join(runtimeRoot, "seeds");
      await mkdir(directory, { mode: 0o700 });
      const path = join(directory, "seeds.tsv");
      await writeGhidraProfileArtifact(path, normalized, resources, signal);
      return path;
    })
    .catch((cause: unknown) => {
      throw ghidraFileFailure(cause, "open_binary", {
        setting: "REA_GHIDRA_SEED_FILE",
        path: commitment.path,
      });
    });

const totalEntries = (commitment: GhidraSeedCommitment): number =>
  commitment.entries.function +
  commitment.entries.code +
  commitment.entries.label;

/** Fail closed when the session did not apply exactly the committed seeds. */
export const ghidraSeedFailure = (
  commitment: GhidraSeedCommitment | undefined,
  report: GhidraSeedReport | undefined,
  operation: AnalysisOperation,
): ProviderAdapterError | undefined => {
  if (commitment === undefined && report === undefined) return undefined;
  const reason =
    commitment === undefined
      ? "The Ghidra session reported analysis seeds that the profile did not commit."
      : report === undefined
        ? "The Ghidra session did not report the committed analysis seeds."
        : report.sha256 !== commitment.sha256 ||
            report.entries !== totalEntries(commitment) ||
            report.function_created +
              report.function_existing +
              report.function_failed >
              commitment.entries.function ||
            report.code_decoded + report.code_failed >
              commitment.entries.code ||
            report.label_applied + report.label_failed >
              commitment.entries.label
          ? "The Ghidra session applied analysis seeds that differ from the committed profile."
          : undefined;
  return reason === undefined
    ? undefined
    : new ProviderAdapterError("ghidra", operation, {
        diagnostics: { reason },
      });
};

/** Session limitations that keep seeded facts distinct from Ghidra discoveries. */
export const ghidraSeedLimitations = (
  commitment: GhidraSeedCommitment | undefined,
  report?: GhidraSeedReport,
): readonly string[] =>
  commitment === undefined
    ? []
    : [
        `Ghidra analysis was seeded before auto-analysis from ${commitment.path} (sha256 ${commitment.sha256}: ${commitment.entries.function} function, ${commitment.entries.code} code, ${commitment.entries.label} label entries). Seeded functions, code and names are caller assertions, not Ghidra discoveries.`,
        ...(report === undefined
          ? []
          : [
              `Seed outcome: ${report.function_created} functions created, ${report.function_existing} already present, ${report.function_failed} failed; ${report.code_decoded} code seeds decoded, ${report.code_failed} failed; ${report.label_applied} labels applied, ${report.label_failed} failed; ${report.unmapped} seeds outside initialized memory.`,
            ]),
      ];
