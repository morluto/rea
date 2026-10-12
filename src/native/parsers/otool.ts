interface ParsedSection {
  readonly segment: string;
  readonly name: string;
  readonly address: string | null;
  readonly size: number | null;
  readonly file_offset: number | null;
  readonly alignment: number | null;
  readonly flags: string[];
}

interface ParsedSegment {
  readonly name: string;
  readonly vm_address: string | null;
  readonly vm_size: number | null;
  readonly file_offset: number | null;
  readonly file_size: number | null;
  readonly maximum_permissions: ReturnType<typeof permissions>;
  readonly initial_permissions: ReturnType<typeof permissions>;
  readonly sections: ParsedSection[];
}

interface ParsedLoadCommands {
  readonly commands: Array<{
    index: number;
    kind: string;
    fields: Record<string, string | number | null>;
  }>;
  readonly segments: ParsedSegment[];
  readonly dependencies: Array<{
    path: string;
    kind: string;
    current_version: string | null;
    compatibility_version: string | null;
  }>;
  readonly entrypoints: Array<{ file_offset: number }>;
  readonly builds: Array<{
    platform: string | null;
    minimum_os: string | null;
    sdk: string | null;
    tools: Array<{ name: string; version: string }>;
  }>;
  uuid: string | null;
  readonly flags: Set<string>;
}

const DYLIB_COMMANDS = new Set([
  "LC_ID_DYLIB",
  "LC_LOAD_DYLIB",
  "LC_LOAD_WEAK_DYLIB",
  "LC_REEXPORT_DYLIB",
  "LC_LAZY_LOAD_DYLIB",
  "LC_LOAD_UPWARD_DYLIB",
]);

const DYLIB_FIELDS = [
  "cmd",
  "cmdsize",
  "name",
  "current version",
  "compatibility version",
];
// otool prints options for dylib_use_command and a timestamp for dylib_command.
const DYLIB_ENCODING_FIELDS = ["time stamp", "options"];
const EMPTY_VALUE_FIELDS = new Set(["options", "segname", "sectname"]);

/**
 * otool emits LF, but a capture replayed from another host or toolchain can
 * carry CRLF. The section/command boundaries below match a bare `\n`, so a
 * stray `\r` would swallow the terminator and silently empty `sections` while
 * leaking section fields into the command. Normalizing once at the boundary
 * keeps every parser below working on one line ending.
 */
const normalizeLineEndings = (output: string): string =>
  output.replaceAll("\r\n", "\n");

/** Parse stable fields from `otool -l`, preserving unknown command fields. */
export const parseOtoolLoadCommands = (raw: string) => {
  const output = normalizeLineEndings(raw);
  const header = parseHeader(output);
  if (header === undefined)
    throw new TypeError("otool output is missing the Mach header");
  const state = createLoadCommandState(header.flags);
  for (const block of output.split(/(?=^Load command \d+$)/mu))
    parseLoadCommand(block, state);
  validateLoadCommandFraming(header, state.commands);
  return {
    fileType: header.fileType,
    flags: [...state.flags].sort(),
    uuid: state.uuid,
    commands: state.commands,
    segments: state.segments,
    dependencies: state.dependencies,
    entrypoints: state.entrypoints,
    builds: state.builds,
  };
};

const parseHeader = (
  output: string,
):
  | {
      fileType: string | null;
      flags: string[];
      commandCount: number;
      commandBytes: number;
    }
  | undefined => {
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  const columnsLine = lines.findIndex((line) => /(?:^|\s)magic\s/u.test(line));
  if (columnsLine < 0) return undefined;
  const columns = lines[columnsLine]?.split(/\s+/u);
  const dataLine = lines.slice(columnsLine + 1).find((line) => line.length > 0);
  const values = dataLine?.split(/\s+/u);
  if (columns === undefined || values === undefined) return undefined;
  const commandCount = headerValue(columns, values, "ncmds");
  const commandBytes = headerValue(columns, values, "sizeofcmds");
  if (commandCount === null || commandBytes === null)
    throw new TypeError("otool Mach header is missing valid command framing");
  const fileTypeIndex = columns.indexOf("filetype");
  const flagsIndex = columns.indexOf("flags");
  const complete = values.length >= columns.length;
  const fileTypeValueIndex =
    flagsIndex >= 0 && fileTypeIndex > flagsIndex
      ? values.length - (columns.length - fileTypeIndex)
      : fileTypeIndex;
  const flagsEnd =
    flagsIndex >= 0 ? values.length - (columns.length - flagsIndex - 1) : 0;
  return {
    commandCount,
    commandBytes,
    fileType:
      complete && fileTypeValueIndex >= 0 && fileTypeValueIndex < values.length
        ? (values[fileTypeValueIndex] ?? null)
        : null,
    flags:
      !complete || flagsIndex < 0 || flagsIndex >= flagsEnd
        ? []
        : values
            .slice(flagsIndex, flagsEnd)
            .filter((value) => value.length > 0),
  };
};

const headerValue = (
  columns: readonly string[],
  values: readonly string[],
  name: string,
): number | null => {
  const index = columns.indexOf(name);
  if (index < 0) return null;
  const flagsIndex = columns.indexOf("flags");
  const valueIndex =
    flagsIndex >= 0 && index > flagsIndex
      ? values.length - (columns.length - index)
      : index;
  const value = values[valueIndex];
  return value === undefined ? null : numeric(value);
};

const validateLoadCommandFraming = (
  header: { readonly commandCount: number; readonly commandBytes: number },
  commands: readonly {
    readonly index: number;
    readonly fields: Readonly<Record<string, string | number | null>>;
  }[],
): void => {
  if (commands.length !== header.commandCount)
    throw new TypeError(
      "otool load-command count does not match the Mach header",
    );
  let totalBytes = 0;
  for (const [expectedIndex, command] of commands.entries()) {
    const size = numberField(command.fields, "cmdsize");
    if (command.index !== expectedIndex || size === null || size < 8)
      throw new TypeError("otool load-command sequence or size is invalid");
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes))
      throw new TypeError("otool load-command byte count is unsafe");
  }
  if (totalBytes !== header.commandBytes)
    throw new TypeError(
      "otool load-command sizes do not match the Mach header",
    );
};

const createLoadCommandState = (
  headerFlags: readonly string[] | undefined,
): ParsedLoadCommands => ({
  commands: [],
  segments: [],
  dependencies: [],
  entrypoints: [],
  builds: [],
  uuid: null,
  flags: new Set(headerFlags ?? []),
});

const parseLoadCommand = (block: string, state: ParsedLoadCommands): void => {
  const indexText = /^Load command (\d+)/u.exec(block)?.[1];
  if (indexText === undefined) return;
  const index = Number(indexText);
  if (!Number.isSafeInteger(index))
    throw new TypeError("otool load-command index is unsafe");
  const header = block.split(/\n\s*Section\n/u)[0] ?? block;
  const parsed = parseFields(header);
  const fields = parsed.values;
  const kind = stringField(fields, "cmd");
  if (kind === null) throw new TypeError("otool load command is missing cmd");
  for (const key of scalarFields(kind)) requireUniqueField(parsed, key);
  if (DYLIB_COMMANDS.has(kind)) validateDylibCommandLines(parsed);
  state.commands.push({
    index,
    kind,
    fields,
  });
  collectUuid(kind, fields, state);
  collectEntrypoint(kind, fields, state);
  collectBuild(kind, block, fields, state);
  collectDependency(kind, fields, state);
  collectSegment(kind, block, fields, state);
};

const validateDylibCommandLines = (parsed: ParsedFields): void => {
  const encodingFields = DYLIB_ENCODING_FIELDS.filter((key) =>
    Object.hasOwn(parsed.values, key),
  );
  if (encodingFields.length !== 1)
    throw new TypeError(
      "otool dylib command must contain timestamp or options",
    );
  for (const key of encodingFields) requireUniqueField(parsed, key);
  const allowed = new Set([...DYLIB_FIELDS, ...DYLIB_ENCODING_FIELDS]);
  for (const field of parsed.rows) {
    const key = field?.[0];
    if (key === undefined || !allowed.has(key))
      throw new TypeError(
        "otool dylib command contains ambiguous multiline text",
      );
  }
};

const scalarFields = (kind: string): readonly string[] => {
  const common = ["cmd", "cmdsize"];
  if (DYLIB_COMMANDS.has(kind)) return DYLIB_FIELDS;
  if (kind === "LC_LOAD_DYLINKER" || kind === "LC_ID_DYLINKER")
    return [...common, "name"];
  if (kind === "LC_UUID") return [...common, "uuid"];
  if (kind === "LC_MAIN") return [...common, "entryoff"];
  if (kind === "LC_BUILD_VERSION")
    return [...common, "platform", "minos", "sdk", "ntools"];
  if (kind.startsWith("LC_VERSION_MIN_")) return [...common, "version", "sdk"];
  if (kind === "LC_SEGMENT" || kind === "LC_SEGMENT_64")
    return [
      ...common,
      "segname",
      "vmaddr",
      "vmsize",
      "fileoff",
      "filesize",
      "maxprot",
      "initprot",
      "nsects",
      "flags",
    ];
  return common;
};

const collectUuid = (
  kind: string,
  fields: Readonly<Record<string, string | number | null>>,
  state: ParsedLoadCommands,
): void => {
  if (kind === "LC_UUID")
    state.uuid = stringField(fields, "uuid") ?? state.uuid;
};

const collectEntrypoint = (
  kind: string,
  fields: Readonly<Record<string, string | number | null>>,
  state: ParsedLoadCommands,
): void => {
  if (kind !== "LC_MAIN") return;
  const entry = numberField(fields, "entryoff");
  if (entry !== null) state.entrypoints.push({ file_offset: entry });
};

const collectBuild = (
  kind: string,
  block: string,
  fields: Readonly<Record<string, string | number | null>>,
  state: ParsedLoadCommands,
): void => {
  if (kind === "LC_BUILD_VERSION") {
    const tools = parseBuildTools(block);
    if (numberField(fields, "ntools") !== tools.length)
      throw new TypeError("otool build-tool count does not match ntools");
    state.builds.push({
      platform: stringField(fields, "platform"),
      minimum_os: stringField(fields, "minos"),
      sdk: stringField(fields, "sdk"),
      tools,
    });
    return;
  }
  if (kind.startsWith("LC_VERSION_MIN_"))
    state.builds.push({
      platform: kind.slice("LC_VERSION_MIN_".length) || null,
      minimum_os: stringField(fields, "version"),
      sdk: stringField(fields, "sdk"),
      tools: [],
    });
};

const collectDependency = (
  kind: string,
  fields: Readonly<Record<string, string | number | null>>,
  state: ParsedLoadCommands,
): void => {
  if (!DYLIB_COMMANDS.has(kind)) return;
  state.dependencies.push({
    path: stripOffsetSuffix(stringField(fields, "name")),
    kind,
    current_version: stringField(fields, "current version"),
    compatibility_version: stringField(fields, "compatibility version"),
  });
};

const collectSegment = (
  kind: string,
  block: string,
  fields: Readonly<Record<string, string | number | null>>,
  state: ParsedLoadCommands,
): void => {
  if (kind !== "LC_SEGMENT" && kind !== "LC_SEGMENT_64") return;
  const segment = parseSegment(block, fields);
  if (numberField(fields, "nsects") !== segment.sections.length)
    throw new TypeError(
      "otool segment section count does not match its sections",
    );
  state.segments.push(segment);
};

interface ParsedFields {
  readonly values: Record<string, string | number | null>;
  readonly rows: readonly (readonly [string, string] | undefined)[];
}

const parseFields = (block: string): ParsedFields => {
  const fields: Record<string, string | number | null> = {};
  const rows: Array<readonly [string, string] | undefined> = [];
  for (const rawLine of block.split(/\r?\n/u).slice(1)) {
    if (rawLine.trim().length === 0) continue;
    const field = parseField(rawLine);
    rows.push(field);
    if (field === undefined) continue;
    const [key, value] = field;
    fields[key] =
      key === "segname" || key === "sectname"
        ? value
        : (numeric(value) ?? value);
  }
  return { values: fields, rows };
};

const parseField = (rawLine: string): readonly [string, string] | undefined => {
  const line = rawLine.trim();
  // Match time stamp as a whole without swallowing `name stamp plugin.dylib`.
  const match = /^((?:time stamp)|\S+(?:\s+version)?)(?:\s+(.+))?$/u.exec(line);
  return match?.[1] === undefined
    ? undefined
    : [match[1], match[2]?.trim() ?? ""];
};

const requireUniqueField = (parsed: ParsedFields, key: string): void => {
  const matches = parsed.rows.filter((field) => field?.[0] === key);
  const field = matches[0];
  if (matches.length !== 1 || field === undefined)
    throw new TypeError(`otool field ${key} is missing or repeated`);
  // Only options and fixed-width Mach-O names may legitimately be empty.
  if (field[1] === "" && !EMPTY_VALUE_FIELDS.has(key))
    throw new TypeError(`otool field ${key} has no value`);
};

const parseSegment = (
  block: string,
  fields: Readonly<Record<string, string | number | null>>,
): ParsedSegment => ({
  name: nonEmptyName(stringField(fields, "segname")),
  vm_address: hexField(fields, "vmaddr"),
  vm_size: numberField(fields, "vmsize"),
  file_offset: numberField(fields, "fileoff"),
  file_size: numberField(fields, "filesize"),
  maximum_permissions: permissions(stringField(fields, "maxprot")),
  initial_permissions: permissions(stringField(fields, "initprot")),
  sections: parseSections(block),
});

const parseSections = (block: string): ParsedSection[] =>
  block
    .split(/(?=\n\s*Section\n)/u)
    .slice(1)
    .map((sectionBlock) => {
      const parsed = parseFields(`Section${sectionBlock}`);
      const fields = parsed.values;
      for (const key of [
        "sectname",
        "segname",
        "addr",
        "size",
        "offset",
        "align",
        "flags",
      ])
        requireUniqueField(parsed, key);
      return {
        segment: nonEmptyName(stringField(fields, "segname")),
        name: nonEmptyName(stringField(fields, "sectname")),
        address: hexField(fields, "addr"),
        size: numberField(fields, "size"),
        file_offset: numberField(fields, "offset"),
        alignment: sectionAlignment(stringField(fields, "align")),
        flags: (stringField(fields, "flags") ?? "")
          .split(/\s+/u)
          .filter((flag) => flag.length > 0),
      };
    });

const parseBuildTools = (
  block: string,
): Array<{ name: string; version: string }> => {
  const tools: Array<{ name: string; version: string }> = [];
  const lines = block.split(/\r?\n/u).map((line) => line.trim());
  for (let index = 0; index < lines.length - 1; index += 1) {
    const tool = /^tool\s+(.+)$/u.exec(lines[index] ?? "")?.[1];
    const version = /^version\s+(.+)$/u.exec(lines[index + 1] ?? "")?.[1];
    if (tool !== undefined && version !== undefined)
      tools.push({ name: tool, version });
  }
  return tools;
};

const permissions = (raw: string | null) => {
  if (raw === null)
    return { read: null, write: null, execute: null, raw: null };
  const numericValue = numeric(raw);
  if (numericValue !== null)
    return {
      read: (numericValue & 1) !== 0,
      write: (numericValue & 2) !== 0,
      execute: (numericValue & 4) !== 0,
      raw,
    };
  if (/^[r-][w-][x-]$/u.test(raw))
    return {
      read: raw[0] === "r",
      write: raw[1] === "w",
      execute: raw[2] === "x",
      raw,
    };
  return { read: null, write: null, execute: null, raw };
};

/** A whole decimal or hexadecimal integer literal, with no surrounding text. */
const NUMERIC_PATTERN = /^(?:0x[a-fA-F0-9]+|\d+)$/u;

const numeric = (value: string): number | null => {
  if (!NUMERIC_PATTERN.test(value)) return null;
  const parsed = Number.parseInt(value, value.startsWith("0x") ? 16 : 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

/** Project an absent or empty Mach-O name as before: the "unknown" label. */
const nonEmptyName = (name: string | null): string =>
  name === null || name.length === 0 ? "unknown" : name;

const stringField = (
  fields: Readonly<Record<string, string | number | null>>,
  name: string,
): string | null => {
  const value = fields[name];
  return typeof value === "string"
    ? value
    : value === undefined || value === null
      ? null
      : String(value);
};

const numberField = (
  fields: Readonly<Record<string, string | number | null>>,
  name: string,
): number | null => {
  const value = fields[name];
  return typeof value === "number"
    ? value
    : typeof value === "string"
      ? numeric(value)
      : null;
};

const hexField = (
  fields: Readonly<Record<string, string | number | null>>,
  name: string,
): string | null => {
  const value = stringField(fields, name);
  if (value === null || !NUMERIC_PATTERN.test(value)) return null;
  return `0x${BigInt(value).toString(16)}`;
};

const stripOffsetSuffix = (value: string | null): string =>
  value?.replace(/\s+\(offset\s+\d+\)$/u, "") ?? "unknown";

const sectionAlignment = (raw: string | null): number | null => {
  if (raw === null) return null;
  const exponent = numeric(/^2\^(\d+)(?:\s+\(\d+\))?$/u.exec(raw)?.[1] ?? raw);
  return exponent === null || exponent > 52 ? null : 2 ** exponent;
};
