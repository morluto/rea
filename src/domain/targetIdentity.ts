import { serializeCanonicalValue } from "./canonicalDigest.js";
import { z } from "zod";

import type {
  BinaryTarget,
  UniversalMachOSliceIdentity,
} from "./binaryTargetTypes.js";
import { digestSchema } from "./digests.js";
import { rawBinaryEntryPointSchema } from "./rawBinary.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const flashOffsetSchema = z.number().int().min(0).max(0xffff_ffff).nullable();
const fatCpuSchema = z.number().int().min(0).max(0xffff_ffff).nullable();

/** Persisted facts inside a file's bytes that select what was analysed. */
export const fileTargetSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("entry-point"),
    entry_point: rawBinaryEntryPointSchema,
  }),
  z.strictObject({
    kind: z.literal("esp-flash"),
    flash_offset: flashOffsetSchema,
    partition_table_offset: flashOffsetSchema,
  }),
  // One slice of a universal Mach-O. The FAT CPU declaration is null when
  // target admission did not supply the validated FAT table.
  z.strictObject({
    kind: z.literal("universal-slice"),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    cpu_type: fatCpuSchema,
    cpu_subtype: fatCpuSchema,
  }),
]);

/**
 * Facts inside a file's bytes that select what was analysed. Two observations
 * of the same bytes with different selections are different targets.
 */
export type FileTargetSelection = z.infer<typeof fileTargetSelectionSchema>;

/**
 * A hashed local file, path-free. Format and architecture are validated by
 * the persistence format that embeds the identity (for Evidence, the
 * format-owned subject declaration).
 */
export const fileTargetIdentitySchema = z.strictObject({
  kind: z.literal("file"),
  sha256: digestSchema,
  format: z.string().min(1),
  architecture: z.string().min(1).nullable(),
  selection: fileTargetSelectionSchema.nullable(),
});

/** A hashed local file, path-free. */
export interface FileTargetIdentity {
  readonly kind: "file";
  readonly sha256: string;
  readonly format: string;
  readonly architecture: string | null;
  readonly selection: FileTargetSelection | null;
}

/**
 * Why an observation names no target: it derives from linked Evidence that
 * already commits to its sources, the producer did not observe the target's
 * identity, the target is not a kind REA can identify, or REA observed the
 * identity and the caller chose not to record it (for example PID
 * normalization).
 */
export const unknownTargetReasonSchema = z.enum([
  "derived-from-linked-evidence",
  "not-observed",
  "unsupported-subject",
  "withheld-by-caller",
]);

/** A target whose identity is unknown, with the reason it is unknown. */
export const unknownTargetIdentitySchema = z.strictObject({
  kind: z.literal("unknown"),
  reason: unknownTargetReasonSchema,
});

/** A target whose identity is unknown, with the reason it is unknown. */
export interface UnknownTargetIdentity {
  readonly kind: "unknown";
  readonly reason: z.infer<typeof unknownTargetReasonSchema>;
}

/** The explicit identity of a target REA did not identify. */
export const unknownTarget = (
  reason: UnknownTargetIdentity["reason"],
): UnknownTargetIdentity => ({ kind: "unknown", reason });

/** The origin a URL serializes to, or null for an opaque origin. */
const urlOrigin = (parsed: URL): string | null =>
  parsed.origin === "null" ? null : parsed.origin;

/**
 * A live document's URL with userinfo removed, and its origin. Userinfo is a
 * transport credential, so an identity that carries it is refused rather
 * than committed.
 */
export const urlTargetIdentitySchema = z
  .strictObject({
    kind: z.literal("url"),
    url: z.string().min(1),
    origin: z.string().min(1).nullable(),
  })
  .superRefine((identity, context) => {
    const parsed = URL.parse(identity.url);
    if (parsed === null) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "A URL target identity must be a parseable URL",
      });
      return;
    }
    if (parsed.username !== "" || parsed.password !== "")
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "A URL target identity must not carry userinfo",
      });
    if (urlOrigin(parsed) !== identity.origin)
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: "A URL target identity's origin must be its URL's origin",
      });
  });

/** A live document's URL with userinfo removed, and its origin. */
export interface UrlTargetIdentity {
  readonly kind: "url";
  readonly url: string;
  readonly origin: string | null;
}

/**
 * A live process named by its PID and the start identity the `src/process`
 * identity primitives read for that PID. A PID alone does not identify a
 * process after exit or reuse, so the start identity is required. The
 * executable digest is null when the executable could not be read stably
 * across launch.
 */
export const processTargetIdentitySchema = z.strictObject({
  kind: z.literal("process"),
  pid: z.int().positive(),
  start_time: z.string().min(1),
  executable_sha256: digestSchema.nullable(),
});

/** A live process named by its PID and start identity. */
export interface ProcessTargetIdentity {
  readonly kind: "process";
  readonly pid: number;
  /** Platform start identity from `src/process`; opaque, compared only for equality. */
  readonly start_time: string;
  readonly executable_sha256: string | null;
}

/** Debugger sessions REA mints and can bind to a launch target. */
export const debuggerSessionKindSchema = z.enum(["rizin", "gdb"]);

/**
 * A debugger session REA minted, bound to the target it launched: the launch
 * file hashed when the session started, or an explicit unknown when REA did
 * not observe it (an attach, or a launch file that could not be hashed).
 * Later debugger commands do not rebind the session.
 */
export const sessionTargetIdentitySchema = z.strictObject({
  kind: z.literal("session"),
  session_kind: debuggerSessionKindSchema,
  id: z.string().min(1),
  target: z.discriminatedUnion("kind", [
    fileTargetIdentitySchema,
    unknownTargetIdentitySchema,
  ]),
});

/** A debugger session REA minted, bound to the target it launched. */
export interface SessionTargetIdentity {
  readonly kind: "session";
  readonly session_kind: z.infer<typeof debuggerSessionKindSchema>;
  readonly id: string;
  readonly target: FileTargetIdentity | UnknownTargetIdentity;
}

/**
 * What an observation or cache entry is about. Tagged by `kind`.
 */
export type TargetIdentity =
  | FileTargetIdentity
  | UrlTargetIdentity
  | ProcessTargetIdentity
  | SessionTargetIdentity
  | UnknownTargetIdentity;

/** A target identity that names no file, and so has no file display facts. */
export type NonFileTargetIdentity = Exclude<TargetIdentity, FileTargetIdentity>;

/**
 * The identities without a nested target that a subject without file display
 * facts can commit to. A session identity nests its target, so a persistence
 * format validates it with its own file declaration.
 */
export const nonFileTargetIdentitySchema = z.discriminatedUnion("kind", [
  unknownTargetIdentitySchema,
  urlTargetIdentitySchema,
  processTargetIdentitySchema,
]);

/** The universal Mach-O slice a target selects, with its FAT CPU declaration when admitted. */
const universalSliceSelection = (
  slice: { readonly offset: number; readonly size: number },
  declarations: readonly UniversalMachOSliceIdentity[] | undefined,
): FileTargetSelection => {
  const declared = declarations?.find(
    (candidate) =>
      candidate.offset === slice.offset && candidate.size === slice.size,
  );
  return {
    kind: "universal-slice",
    offset: slice.offset,
    size: slice.size,
    cpu_type: declared?.cpuType ?? null,
    cpu_subtype: declared?.cpuSubtype ?? null,
  };
};

/** The selection an open binary target makes inside its bytes, if any. */
export const binaryTargetSelection = (
  target: BinaryTarget,
): FileTargetSelection | null =>
  target.format === "raw-binary" || target.format === "gamecube-dol"
    ? { kind: "entry-point", entry_point: target.entryPoint }
    : target.format === "esp-flash-image"
      ? {
          kind: "esp-flash",
          flash_offset: target.espFlash.flashOffset,
          partition_table_offset: target.espFlash.partitionTableOffset,
        }
      : target.format === "mach-o-universal"
        ? universalSliceSelection(target.universalSlice, target.universalSlices)
        : null;

/** The one projection of an open binary target into its target identity. */
export const binaryTargetIdentity = (
  target: BinaryTarget,
): FileTargetIdentity => ({
  kind: "file",
  sha256: target.sha256,
  format: target.format,
  architecture: target.architecture ?? null,
  selection: binaryTargetSelection(target),
});

/** The only comparison of two target identities: an RFC 8785 canonical digest. */
export const targetIdentityKey = (identity: TargetIdentity): string => {
  const encoded = serializeCanonicalValue(identity);
  if (encoded === undefined)
    throw new TypeError("RFC 8785 canonicalization rejected a target identity");
  return `target_${sha256Hex(encoded)}`;
};

/** Whether two identities name the same target. */
export const sameTargetIdentity = (
  left: TargetIdentity,
  right: TargetIdentity,
): boolean => targetIdentityKey(left) === targetIdentityKey(right);
