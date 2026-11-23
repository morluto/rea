import { basename } from "node:path";

import canonicalize from "canonicalize";
import { z } from "zod";
import { utcDateTimeSchema } from "../domain/offsetDateTime.js";
import { releaseProducerIdentity } from "../filesystem/ProducerIdentity.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { kunaExportFileNames } from "./KunaProjectExport.js";
import type {
  KunaInventoryFunction,
  KunaProjectFunction,
} from "./KunaProjectFiles.js";
import type { KunaProjectFileStates } from "./KunaProjectState.js";

/** A manifest names five files and their digests; anything larger is not ours. */
export const MANIFEST_MAX_BYTES = 64 * 1024;

export const KEY_PATTERN = /^[0-9a-f]{64}$/u;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Inputs that determine an export's content. Each one is part of the cache key. */
export interface KunaProjectKeyInputs {
  readonly targetSha256: string;
  readonly targetBasename: string;
  readonly kunaSha256: string;
  readonly kunaCommand: string;
  readonly kunaExecutable: string;
  readonly kunaVersion: string;
  /**
   * `--jobs 1` is Kuna's reference answer; more jobs decompile without
   * callee-first prototypes and change some bodies.
   */
  readonly jobs: number;
}

/** Content address of one export: every input that can change its bytes. */
export const kunaProjectKey = (inputs: KunaProjectKeyInputs): string =>
  sha256Hex(
    canonicalize({
      // The entry layout and manifest meaning are REA's code: a new release
      // keys new entries, and older ones are retired as foreign manifests.
      producer: releaseProducerIdentity(),
      target_sha256: inputs.targetSha256,
      target_basename: inputs.targetBasename,
      kuna_sha256: inputs.kunaSha256,
      kuna_command: inputs.kunaCommand,
      kuna_executable: inputs.kunaExecutable,
      kuna_version: inputs.kunaVersion,
      export: { command: "decompile-project", jobs: inputs.jobs },
    }) ?? "",
  );

const fileSchema = z.strictObject({
  path: z.string().min(1),
  bytes: z.int().nonnegative(),
  sha256: z.string().regex(SHA256_PATTERN),
});

const manifestSchema = z
  .strictObject({
    producer: z.strictObject({ rea_version: z.string().min(1) }),
    key: z.string().regex(KEY_PATTERN),
    inputs: z.strictObject({
      target_sha256: z.string().regex(SHA256_PATTERN),
      target_basename: z.string().min(1),
      kuna_sha256: z.string().regex(SHA256_PATTERN),
      kuna_command: z.string(),
      kuna_executable: z.string(),
      kuna_version: z.string().min(1),
      jobs: z.int().positive(),
    }),
    files: z.strictObject({
      c: fileSchema,
      h: fileSchema,
      asm: fileSchema,
      readme: fileSchema,
      inventory: fileSchema,
    }),
    summary: z.strictObject({
      decompiled: z.int().nonnegative(),
      failed: z.int().nonnegative(),
    }),
    created_at: utcDateTimeSchema,
  })
  .superRefine(({ files, inputs, key, producer }, context) => {
    if (producer.rea_version !== releaseProducerIdentity().rea_version)
      context.addIssue({
        code: "custom",
        path: ["producer"],
        message: "Export cache entry was produced by another REA release",
      });
    if (
      key !==
      kunaProjectKey({
        targetSha256: inputs.target_sha256,
        targetBasename: inputs.target_basename,
        kunaSha256: inputs.kuna_sha256,
        kunaCommand: inputs.kuna_command,
        kunaExecutable: inputs.kuna_executable,
        kunaVersion: inputs.kuna_version,
        jobs: inputs.jobs,
      })
    )
      context.addIssue({
        code: "custom",
        path: ["key"],
        message: "Export cache key does not match its producing inputs",
      });
    const stem = inputs.target_basename;
    if (
      stem.length === 0 ||
      stem === "." ||
      stem === ".." ||
      stem.includes("\0") ||
      basename(stem) !== stem
    ) {
      context.addIssue({
        code: "custom",
        path: ["files", "c", "path"],
        message: "Export source must use the target's native basename",
      });
      return;
    }
    const expected = kunaExportFileNames(stem);
    for (const role of Object.keys(expected) as (keyof typeof expected)[])
      if (files[role].path !== expected[role])
        context.addIssue({
          code: "custom",
          path: ["files", role, "path"],
          message: "Export file does not match its producer role and basename",
        });
  });

/** Immutable description of one published export, written once at publish. */
export type KunaProjectManifest = z.infer<typeof manifestSchema>;

/** One verified, published export. */
export interface KunaProject {
  readonly fileStates: KunaProjectFileStates;
  readonly key: string;
  /** Directory holding the export's `.c`, `.h`, `.asm`, README and inventory. */
  readonly directory: string;
  readonly manifest: KunaProjectManifest;
  /** Decompiled function blocks in `.c` order. */
  readonly functions: readonly KunaProjectFunction[];
  /** Every callable entry Kuna found, including imports it does not decompile. */
  readonly inventory: readonly KunaInventoryFunction[];
}

export const parseManifest = (
  text: string,
): KunaProjectManifest | undefined => {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export const manifestBytes = (manifest: KunaProjectManifest): number =>
  Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0);
