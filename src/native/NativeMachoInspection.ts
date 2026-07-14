import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { AnalysisError } from "../domain/errors.js";
import {
  inspectMachoSchema,
  type NativeCommandInvocation,
} from "../domain/nativeInspection.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { NativeCommandCapture } from "./CommandRunner.js";
import { parseDyldSymbols } from "./parsers/dyldInfo.js";
import { parseLipoArchitectures } from "./parsers/lipo.js";
import { parseOtoolLoadCommands } from "./parsers/otool.js";

interface NativeMachoObservation {
  readonly result: JsonValue;
  readonly provenance: readonly NativeCommandInvocation[];
  readonly limitations: readonly string[];
  readonly locations: readonly EvidenceLocation[];
}

interface NativeMachoInspectionContext {
  readonly target: BinaryTarget;
  readonly signal?: AbortSignal;
  readonly run: (
    tool: string,
    arguments_: readonly string[],
    signal?: AbortSignal,
  ) => Promise<Result<NativeCommandCapture, AnalysisError>>;
  readonly invocation: (
    capture: NativeCommandCapture,
  ) => NativeCommandInvocation;
}

const REQUIRED_COMMANDS = [
  ["file", ["-b"]],
  ["lipo", ["-detailed_info"]],
  ["otool", ["-l"]],
  ["nm", ["-gjU"]],
  ["dyld_info", ["-imports"]],
  ["dyld_info", ["-exports"]],
  ["dwarfdump", ["--uuid"]],
] as const;

const OPTIONAL_VTOOL_COMMAND = ["vtool", ["-show-build"]] as const;
const VTOOL_UNAVAILABLE_LIMITATION =
  "vtool is unavailable; build metadata is normalized from otool only.";

/** Inspect one Mach-O with bounded native commands and normalized output. */
export const inspectNativeMacho = async (
  context: NativeMachoInspectionContext,
): Promise<Result<NativeMachoObservation, AnalysisError>> => {
  const captures: NativeCommandCapture[] = [];
  for (const [tool, prefix] of REQUIRED_COMMANDS) {
    const captured = await context.run(
      tool,
      [...prefix, context.target.path],
      context.signal,
    );
    if (!captured.ok) return err(captured.error);
    captures.push(captured.value);
  }
  const limitations: string[] = [];
  const [tool, prefix] = OPTIONAL_VTOOL_COMMAND;
  const optional = await context.run(
    tool,
    [...prefix, context.target.path],
    context.signal,
  );
  if (optional.ok) captures.push(optional.value);
  else if (optional.error._tag === "AnalysisCapabilityUnavailableError")
    limitations.push(VTOOL_UNAVAILABLE_LIMITATION);
  else return err(optional.error);
  const result = normalizeMacho(captures, context.invocation, limitations);
  return ok({
    result: jsonValueSchema.parse(result),
    provenance: result.provenance,
    limitations: result.limitations,
    locations: fileOffsetLocations(result),
  });
};

const normalizeMacho = (
  captures: readonly NativeCommandCapture[],
  toInvocation: (capture: NativeCommandCapture) => NativeCommandInvocation,
  additionalLimitations: readonly string[],
) => {
  const byTool = captureLookup(captures);
  const architectures = parseLipoArchitectures(byTool("lipo").stdout);
  const load = parseOtoolLoadCommands(byTool("otool").stdout);
  const imports = parseDyldSymbols(byTool("dyld_info", 0).stdout, "imports");
  const dyldExports = parseDyldSymbols(
    byTool("dyld_info", 1).stdout,
    "exports",
  );
  const exports = uniqueSymbols([
    ...dyldExports,
    ...parseNmExports(byTool("nm").stdout),
  ]);
  const uuid =
    /UUID:\s*([A-Fa-f0-9-]+)/u.exec(byTool("dwarfdump").stdout)?.[1] ??
    load.uuid;
  const provenance = captures.map(toInvocation);
  const limitations = [
    "Imports and exports combine dyld_info and nm; stripped or toolchain-hidden symbols may be absent.",
    ...(captures.some(({ tool }) => tool === "vtool")
      ? [
          "vtool output is retained as provenance but only otool build metadata is normalized.",
        ]
      : []),
    ...additionalLimitations,
  ];
  return inspectMachoSchema.parse({
    format: "mach-o",
    endian: parseEndian(byTool("file").stdout),
    word_size: parseWordSize(byTool("file").stdout),
    file_type: load.fileType,
    flags: load.flags,
    uuid: uuid ?? null,
    entrypoints: covered(load.entrypoints, true),
    architectures: covered(architectures, true),
    build_metadata: covered(load.builds, true),
    load_commands: covered(load.commands, true),
    dependencies: covered(load.dependencies, true),
    imports: covered(imports, false, [
      "dyld_info textual imports may omit chained or toolchain-unsupported metadata.",
    ]),
    exports: covered(exports, false, [
      "Merged nm/dyld_info results may be incomplete for stripped binaries.",
    ]),
    segments: covered(
      load.segments.map((segment) => ({
        ...segment,
        sections: covered(segment.sections, true),
      })),
      true,
    ),
    provenance,
    limitations,
  });
};

const captureLookup =
  (captures: readonly NativeCommandCapture[]) =>
  (tool: string, occurrence = 0): NativeCommandCapture => {
    const capture = captures.filter((item) => item.tool === tool)[occurrence];
    if (capture === undefined) throw new TypeError(`Missing ${tool} capture`);
    return capture;
  };

const parseNmExports = (output: string) =>
  output
    .split(/\r?\n/u)
    .filter((name) => name.length > 0)
    .map((name) => ({
      name,
      address: null,
      weak: null,
      reexport: null,
      source: "nm",
    }));

const parseEndian = (output: string): "little" | "big" | null =>
  /little-endian/iu.test(output)
    ? "little"
    : /big-endian/iu.test(output)
      ? "big"
      : null;

const parseWordSize = (output: string): 32 | 64 | null =>
  /64-bit/iu.test(output) ? 64 : /32-bit/iu.test(output) ? 32 : null;

const covered = <Value>(
  items: readonly Value[],
  exhaustive: boolean,
  limitations: readonly string[] = [],
) => ({
  items: [...items],
  total: exhaustive ? items.length : null,
  exhaustive,
  limitations: [...limitations],
});

const uniqueSymbols = <Value extends { readonly name: string }>(
  items: readonly Value[],
): Value[] => {
  const unique = new Map<string, Value>();
  for (const item of items) unique.set(item.name, item);
  return [...unique.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
};

const fileOffsetLocations = (
  macho: ReturnType<typeof inspectMachoSchema.parse>,
): EvidenceLocation[] => {
  const locations = architectureLocations(macho.architectures.items);
  for (const segment of macho.segments.items) {
    if (segment.file_offset === null || segment.file_size === null) continue;
    locations.push({
      kind: "file-offset-range",
      start: segment.file_offset,
      end: segment.file_offset + segment.file_size,
    });
  }
  return locations;
};

/** Project architecture slices into evidence file-offset locations. */
export const architectureLocations = (
  architectures: readonly {
    readonly file_offset: number | null;
    readonly size: number | null;
  }[],
): EvidenceLocation[] => {
  const locations: EvidenceLocation[] = [];
  for (const { file_offset: offset, size } of architectures) {
    if (offset === null) continue;
    locations.push(
      size === null
        ? { kind: "file-offset", offset }
        : { kind: "file-offset-range", start: offset, end: offset + size },
    );
  }
  return locations;
};
