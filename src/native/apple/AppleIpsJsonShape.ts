import type { InspectAppleIpsInput } from "../../domain/native/appleIps.js";
import { APPLE_IPS_FORMAT, appleIpsLimit } from "./AppleIps.errors.js";
import {
  parseLosslessJson,
  LosslessJsonFailure,
  type JsonShape,
  type LosslessJson,
} from "./losslessJson.js";
import {
  malformedInput,
  ParseFailureError,
} from "../../domain/parseFailure.js";

/** IPS JSON is at most a handful of levels deep; deeper input is not a crash report shape. */
const MAX_IPS_JSON_DEPTH = 64;

const SCALAR: JsonShape = { kind: "scalar" };

const scalarMembers = (
  ...names: readonly string[]
): Record<string, JsonShape> =>
  Object.fromEntries(names.map((name) => [name, SCALAR]));

const unlistedKeyAllowance = (maximum: number) => (count: number) => {
  if (count > maximum)
    throw appleIpsLimit(
      "unlisted_keys",
      maximum,
      `Crash report lists more than ${String(maximum)} unlisted keys in one object, above the selected ${String(maximum)}-entry unlisted_keys allowance`,
    );
};

/** One running count per selected row collection, checked before each row. */
const selectedAllowances = (input: InspectAppleIpsInput) => {
  const counts = {
    threads: 0,
    frames: 0,
    images: 0,
    registers: 0,
    termination_reasons: 0,
  };
  const take =
    (boundary: keyof typeof counts, maximum: number, noun: string) => () => {
      counts[boundary] += 1;
      if (counts[boundary] > maximum)
        throw appleIpsLimit(
          boundary,
          maximum,
          `Crash report lists more than ${String(maximum)} ${noun}, above the selected ${String(maximum)}-entry ${boundary} allowance`,
        );
    };
  return {
    threads: take("threads", input.max_threads, "threads"),
    frames: take("frames", input.max_frames, "frames"),
    images: take("images", input.max_images, "usedImages rows"),
    registers: take(
      "registers",
      input.max_registers,
      "threadState register slots",
    ),
    terminationReasons: take(
      "termination_reasons",
      input.max_termination_reasons,
      "termination reasons",
    ),
    unlistedKeys: unlistedKeyAllowance(input.max_unlisted_keys),
  };
};

const threadShape = (
  take: ReturnType<typeof selectedAllowances>,
): JsonShape => {
  const register: JsonShape = {
    kind: "object",
    members: scalarMembers("value", "description"),
  };
  return {
    kind: "object",
    members: {
      ...scalarMembers("id", "triggered", "name", "queue"),
      frames: {
        kind: "array",
        items: {
          kind: "object",
          members: scalarMembers(
            "imageIndex",
            "imageOffset",
            "symbol",
            "symbolLocation",
            "inline",
          ),
          beforeUnlisted: take.unlistedKeys,
        },
        beforeItem: take.frames,
      },
      threadState: {
        kind: "object",
        members: {
          flavor: SCALAR,
          x: { kind: "array", items: register, beforeItem: take.registers },
          // Rosetta-translated processes nest their translator registers.
          rosetta: {
            kind: "object",
            members: {},
            rest: register,
            beforeRest: take.registers,
          },
        },
        rest: register,
        beforeRest: take.registers,
      },
    },
    beforeUnlisted: take.unlistedKeys,
  };
};

const terminationShape = (
  take: ReturnType<typeof selectedAllowances>,
): JsonShape => ({
  kind: "object",
  members: {
    ...scalarMembers(
      "namespace",
      "code",
      "indicator",
      "flags",
      "byPid",
      "byProc",
    ),
    reasons: {
      kind: "array",
      items: SCALAR,
      beforeItem: take.terminationReasons,
    },
  },
  beforeUnlisted: take.unlistedKeys,
});

/**
 * Projection of the documented IPS crash body. Budget callbacks fire before
 * each row is parsed, so selected allowances bound allocation rather than
 * output, and members the report does not interpret are never materialized.
 */
export const ipsBodyShape = (input: InspectAppleIpsInput): JsonShape => {
  const take = selectedAllowances(input);
  return {
    kind: "object",
    members: {
      ...scalarMembers(
        "procName",
        "procPath",
        "pid",
        "parentPid",
        "parentProc",
        "cpuType",
        "translated",
        "faultingThread",
      ),
      osVersion: {
        kind: "object",
        members: scalarMembers("train", "build", "releaseType", "isEmbedded"),
        beforeUnlisted: take.unlistedKeys,
      },
      exception: {
        kind: "object",
        members: scalarMembers("type", "signal", "subtype", "codes", "message"),
        beforeUnlisted: take.unlistedKeys,
      },
      termination: terminationShape(take),
      threads: {
        kind: "array",
        items: threadShape(take),
        beforeItem: take.threads,
      },
      usedImages: {
        kind: "array",
        items: {
          kind: "object",
          members: scalarMembers(
            "source",
            "arch",
            "base",
            "size",
            "uuid",
            "name",
            "path",
          ),
          beforeUnlisted: take.unlistedKeys,
        },
        beforeItem: take.images,
      },
    },
    beforeUnlisted: take.unlistedKeys,
  };
};

/** Projection of the first-line IPS metadata object. */
export const ipsMetadataShape = (input: InspectAppleIpsInput): JsonShape => ({
  kind: "object",
  members: scalarMembers(
    "bug_type",
    "timestamp",
    "os_version",
    "bundleID",
    "incident_id",
    "name",
    "build_version",
    "platform",
  ),
  beforeUnlisted: unlistedKeyAllowance(input.max_unlisted_keys),
});

/** Parse one complete JSON value under a projection, mapping failures to IPS errors. */
export const consumeJson = (
  text: string,
  label: string,
  shape: JsonShape,
): LosslessJson => {
  try {
    const parsed = parseLosslessJson(text, 0, shape, {
      maxDepth: MAX_IPS_JSON_DEPTH,
    });
    if (!/^[\u0020\u0009\u000a\u000d]*$/u.test(text.slice(parsed.end)))
      throw malformedInput(
        APPLE_IPS_FORMAT,
        `${label} has trailing JSON text after the first complete value`,
      );
    return parsed.value;
  } catch (cause) {
    if (cause instanceof ParseFailureError) throw cause;
    if (cause instanceof LosslessJsonFailure && cause.reason === "depth")
      throw appleIpsLimit(
        "nesting",
        cause.maximum ?? MAX_IPS_JSON_DEPTH,
        `${label}: ${cause.message}`,
      );
    const message =
      cause instanceof LosslessJsonFailure ? cause.message : String(cause);
    throw malformedInput(APPLE_IPS_FORMAT, `${label}: ${message}`);
  }
};
