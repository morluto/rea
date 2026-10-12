import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import {
  inspectMachoSchema,
  type NativeCommandInvocation,
} from "../domain/native/nativeInspection.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { NativeCommandCapture } from "./CommandRunner.js";
import { parseDyldSymbols } from "./parsers/dyldInfo.js";
import { parseLipoArchitectures } from "./parsers/lipo.js";
import { withoutEchoedPathHeader } from "./parsers/echoedPath.js";
import { parseOtoolLoadCommands } from "./parsers/otool.js";
import { reconcileMachoUuid } from "./parsers/machoUuid.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

interface NativeMachoObservation {
  readonly result: JsonValue;
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

const DISCOVERY_COMMANDS = [
  ["file", ["-b"]],
  ["lipo", ["-detailed_info"]],
] as const;

const REQUIRED_SLICE_COMMANDS = [
  ["otool", ["-h", "-l"]],
  ["nm", ["-gjU"]],
  ["dyld_info", ["-imports"]],
  ["dyld_info", ["-exports"]],
  ["dwarfdump", ["--uuid"]],
] as const;

const OPTIONAL_VTOOL_COMMAND = ["vtool", ["-show-build"]] as const;
const VTOOL_UNAVAILABLE_LIMITATION =
  "vtool is unavailable; build metadata is normalized from otool only.";
/** Inspect one Mach-O with the required native commands and normalized output. */
export const inspectNativeMacho = async (
  context: NativeMachoInspectionContext,
): Promise<Result<NativeMachoObservation, AnalysisError>> => {
  const captures: NativeCommandCapture[] = [];
  for (const [tool, prefix] of DISCOVERY_COMMANDS) {
    const captured = await context.run(
      tool,
      [...prefix, context.target.path],
      context.signal,
    );
    if (!captured.ok) return err(captured.error);
    captures.push(captured.value);
  }
  const lipo = captures.find(({ tool }) => tool === "lipo");
  if (lipo === undefined) throw new TypeError("Missing lipo capture");
  const architectures = parseLipoArchitectures(lipo.stdout);
  const availableArchitectures = architectures.map(({ name }) => name);
  const selection = selectArchitecture(context.target, availableArchitectures);
  if (selection.status === "absent")
    return err(
      new AnalysisOutputError(
        "inspect_macho",
        `lipo did not list ${selection.architecture}; refusing to read another slice`,
      ),
    );
  const selectedArchitecture =
    selection.status === "selected" ? selection.architecture : null;
  for (const [tool, prefix] of REQUIRED_SLICE_COMMANDS) {
    const captured = await context.run(
      tool,
      [
        ...prefix,
        ...selectedArchitectureArguments(tool, selectedArchitecture),
        context.target.path,
      ],
      context.signal,
    );
    if (!captured.ok) return err(captured.error);
    captures.push(captured.value);
  }
  const limitations: string[] = [];
  const [tool, prefix] = OPTIONAL_VTOOL_COMMAND;
  const optional = await context.run(
    tool,
    [
      ...prefix,
      ...selectedArchitectureArguments(tool, selectedArchitecture),
      context.target.path,
    ],
    context.signal,
  );
  if (optional.ok) captures.push(optional.value);
  else if (optional.error._tag === "AnalysisCapabilityUnavailableError")
    limitations.push(VTOOL_UNAVAILABLE_LIMITATION);
  else return err(optional.error);
  const otool = captures.find(({ tool }) => tool === "otool");
  if (otool === undefined) throw new TypeError("Missing otool capture");
  let load: ReturnType<typeof parseOtoolLoadCommands>;
  try {
    load = parseOtoolLoadCommands(sliceOutput(otool));
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(
        "inspect_macho",
        "Malformed otool load-command output",
        {
          cause,
          capturedOutput: {
            stdout: otool.stdout,
            stderr: otool.stderr,
            truncated: false,
            stdout_bytes: otool.stdoutBytes,
            stderr_bytes: otool.stderrBytes,
            exit_code: otool.exitCode,
            signal: otool.signal,
          },
        },
      ),
    );
  }
  const selectedArchitectureName =
    selectedArchitecture ??
    (architectures.length === 1 ? (architectures[0]?.name ?? null) : null);
  const containerOffset =
    selectedArchitectureName === null
      ? undefined
      : /^Non-fat file:/mu.test(lipo.stdout)
        ? 0
        : (architectures.find(({ name }) => name === selectedArchitectureName)
            ?.file_offset ?? undefined);
  const normalized = normalizeMacho(
    captures,
    context.invocation,
    limitations,
    load,
    architectures,
    context.target.path,
    {
      name: selectedArchitectureName,
      container_file_offset: containerOffset ?? null,
    },
  );
  const result =
    containerOffset === undefined
      ? inspectMachoSchema.parse({
          ...normalized,
          limitations: [
            ...normalized.limitations,
            selectedArchitectureName === null
              ? "The selected Mach-O slice is unknown; slice-based evidence locations are unavailable."
              : "The selected Mach-O slice's container file offset was not observed; slice-based evidence locations are unavailable.",
          ],
        })
      : normalized;
  return ok({
    result: jsonValueSchema.parse(result),
    limitations: result.limitations,
    locations: fileOffsetLocations(result, containerOffset),
  });
};

const normalizeMacho = (
  captures: readonly NativeCommandCapture[],
  toInvocation: (capture: NativeCommandCapture) => NativeCommandInvocation,
  additionalLimitations: readonly string[],
  load: ReturnType<typeof parseOtoolLoadCommands>,
  architectures: ReturnType<typeof parseLipoArchitectures>,
  artifactPath: string,
  selectedArchitecture: {
    readonly name: string | null;
    readonly container_file_offset: number | null;
  },
) => {
  const byTool = captureLookup(captures);
  const imports = parseDyldSymbols(
    sliceOutput(byTool("dyld_info", 0)),
    "imports",
  );
  const imageBase =
    load.segments.find(
      (segment) => segment.file_offset === 0 && (segment.file_size ?? 0) > 0,
    )?.vm_address ?? null;
  const nmExports = parseNmExports(byTool("nm").stdout);
  const dyldExports = parseDyldSymbols(
    sliceOutput(byTool("dyld_info", 1)),
    "exports",
    imageBase,
    new Set(nmExports.map(({ name }) => name)),
  );
  const exports = uniqueSymbols([...dyldExports, ...nmExports]);
  const dwarfdump = byTool("dwarfdump");
  const uuid = reconcileMachoUuid(
    load.commands,
    dwarfdump.stdout,
    artifactPath,
    selectedArchitecture.name,
  );
  const provenance = captures.map(toInvocation);
  // A thread-state command carries the entrypoint in architecture-specific
  // register state, so an absent decoded offset means unknown, not absent.
  const threadEntrypoint =
    load.entrypoints.length === 0 &&
    load.commands.some(
      (command) =>
        command.kind === "LC_UNIXTHREAD" || command.kind === "LC_THREAD",
    );
  const threadEntrypointLimitation =
    "Thread-state entrypoints (LC_UNIXTHREAD/LC_THREAD) are retained as raw load commands; file offsets are not derived.";
  const limitations = [
    "Imports and exports combine dyld_info and nm; stripped or toolchain-hidden symbols may be absent.",
    ...(captures.some(({ tool }) => tool === "vtool")
      ? [
          "vtool output is retained as provenance but only otool build metadata is normalized.",
        ]
      : []),
    ...additionalLimitations,
    ...uuid.limitations,
    ...(threadEntrypoint ? [threadEntrypointLimitation] : []),
    ...(imageBase === null &&
    /^\s*offset\s+symbol\s*$/mu.test(sliceOutput(byTool("dyld_info", 1)))
      ? [
          "Export virtual addresses are unavailable because no file-backed image base was observed.",
        ]
      : []),
  ];
  return inspectMachoSchema.parse({
    format: "mach-o",
    selected_architecture: selectedArchitecture,
    endian: parseEndian(byTool("file").stdout),
    word_size: parseWordSize(byTool("file").stdout),
    file_type: load.fileType,
    flags: load.flags,
    uuid: uuid.value,
    entrypoints: covered(
      load.entrypoints,
      !threadEntrypoint,
      threadEntrypoint ? [threadEntrypointLimitation] : [],
    ),
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

/** Slice output without the echoed operand path, which can contain any text. */
const sliceOutput = (capture: NativeCommandCapture): string =>
  withoutEchoedPathHeader(capture.stdout, capture.arguments.at(-1));

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
  for (const item of items)
    if (!unique.has(item.name)) unique.set(item.name, item);
  return [...unique.values()].sort((left, right) =>
    compareUnicodeCodePoints(left.name, right.name),
  );
};

const fileOffsetLocations = (
  macho: ReturnType<typeof inspectMachoSchema.parse>,
  containerOffset: number | undefined,
): EvidenceLocation[] => {
  const locations = architectureLocations(macho.architectures.items);
  if (containerOffset === undefined) return locations;
  for (const entrypoint of macho.entrypoints.items)
    locations.push({
      kind: "file-offset",
      offset: containerOffset + entrypoint.file_offset,
    });
  for (const segment of macho.segments.items) {
    if (
      segment.file_offset === null ||
      segment.file_size === null ||
      segment.file_size === 0
    )
      continue;
    locations.push({
      kind: "file-offset-range",
      start: containerOffset + segment.file_offset,
      end: containerOffset + segment.file_offset + segment.file_size,
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

const selectedArchitectureArguments = (
  tool: string,
  architecture: string | null,
): string[] => {
  if (architecture === null) return [];
  const baseArchitecture = architecture.split(".")[0] ?? architecture;
  // dyld_info distinguishes arm64e ABI variants; the other Apple tools use
  // the base CPU-family spelling for the same slice.
  const toolArchitecture =
    tool === "dyld_info" ? architecture : baseArchitecture;
  return tool === "dwarfdump"
    ? [`--arch=${toolArchitecture}`]
    : ["-arch", toolArchitecture];
};

type ArchitectureSelection =
  | { readonly status: "unfiltered" }
  | { readonly status: "selected"; readonly architecture: string }
  | { readonly status: "absent"; readonly architecture: string };

const selectArchitecture = (
  target: BinaryTarget,
  available: readonly string[],
): ArchitectureSelection => {
  if (target.kind !== "executable" || target.availableArchitectures.length < 2)
    return { status: "unfiltered" };
  const normalized =
    target.architecture === "x86" ? "i386" : target.architecture;
  if (available.includes(normalized))
    return { status: "selected", architecture: normalized };
  // BinaryTarget intentionally normalizes ARM64 CPU subtypes. Recover the
  // concrete arm64e slice name from lipo before invoking slice-aware tools.
  if (normalized === "arm64") {
    const arm64e = available.find((architecture) => architecture === "arm64e");
    if (arm64e !== undefined)
      return { status: "selected", architecture: arm64e };
    const variant = available.find((architecture) =>
      /^arm64e\.[A-Za-z0-9_]+$/u.test(architecture),
    );
    if (variant !== undefined)
      return { status: "selected", architecture: variant };
  }
  return { status: "absent", architecture: normalized };
};
