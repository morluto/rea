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
    file_offset: number | null;
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

/** Parse stable fields from `otool -l`, preserving unknown command fields. */
export const parseOtoolLoadCommands = (output: string) => {
  const headerTokens = parseHeaderTokens(output);
  const state = createLoadCommandState(headerTokens);
  for (const block of output.split(/(?=Load command \d+)/u))
    parseLoadCommand(block, state);
  return {
    fileType: headerTokens?.[4] ?? null,
    flags: [...state.flags].sort(),
    uuid: state.uuid,
    commands: state.commands,
    segments: state.segments,
    dependencies: state.dependencies,
    entrypoints: state.entrypoints,
    builds: state.builds,
  };
};

const parseHeaderTokens = (output: string): string[] | undefined =>
  output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^0x[a-fA-F0-9]+\s/u.test(line))
    ?.split(/\s+/u);

const createLoadCommandState = (
  headerTokens: readonly string[] | undefined,
): ParsedLoadCommands => ({
  commands: [],
  segments: [],
  dependencies: [],
  entrypoints: [],
  builds: [],
  uuid: null,
  flags: new Set(headerTokens?.slice(7) ?? []),
});

const parseLoadCommand = (block: string, state: ParsedLoadCommands): void => {
  const indexText = /^Load command (\d+)/u.exec(block)?.[1];
  if (indexText === undefined) return;
  const header = block.split(/\n\s*Section\n/u)[0] ?? block;
  const fields = parseFields(header);
  const kind = stringField(fields, "cmd") ?? "unknown";
  state.commands.push({
    index: Number.parseInt(indexText, 10),
    kind,
    file_offset: null,
    fields,
  });
  collectUuid(kind, fields, state);
  collectEntrypoint(kind, fields, state);
  collectBuild(kind, block, fields, state);
  collectDependency(kind, fields, state);
  collectSegment(kind, block, fields, state);
  collectFlags(fields, state.flags);
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
  if (kind !== "LC_BUILD_VERSION") return;
  state.builds.push({
    platform: stringField(fields, "platform"),
    minimum_os: stringField(fields, "minos"),
    sdk: stringField(fields, "sdk"),
    tools: parseBuildTools(block),
  });
};

const collectDependency = (
  kind: string,
  fields: Readonly<Record<string, string | number | null>>,
  state: ParsedLoadCommands,
): void => {
  if (!kind.startsWith("LC_LOAD_") && kind !== "LC_ID_DYLIB") return;
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
  if (kind === "LC_SEGMENT" || kind === "LC_SEGMENT_64")
    state.segments.push(parseSegment(block, fields));
};

const collectFlags = (
  fields: Readonly<Record<string, string | number | null>>,
  flags: Set<string>,
): void => {
  const rawFlags = stringField(fields, "flags");
  if (rawFlags === null) return;
  for (const flag of rawFlags.split(/\s+/u))
    if (flag.length > 0) flags.add(flag);
};

const parseFields = (block: string): Record<string, string | number | null> => {
  const fields: Record<string, string | number | null> = {};
  for (const rawLine of block.split(/\r?\n/u).slice(1)) {
    const line = rawLine.trim();
    const match = /^(\S+(?:\s+version)?)\s+(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const value = match[2].trim();
    fields[match[1]] = numeric(value) ?? value;
  }
  return fields;
};

const parseSegment = (
  block: string,
  fields: Readonly<Record<string, string | number | null>>,
): ParsedSegment => ({
  name: stringField(fields, "segname") ?? "unknown",
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
      const fields = parseFields(`Section${sectionBlock}`);
      return {
        segment: stringField(fields, "segname") ?? "unknown",
        name: stringField(fields, "sectname") ?? "unknown",
        address: hexField(fields, "addr"),
        size: numberField(fields, "size"),
        file_offset: numberField(fields, "offset"),
        alignment: sectionAlignment(numberField(fields, "align")),
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
      read: (numericValue & 4) !== 0,
      write: (numericValue & 2) !== 0,
      execute: (numericValue & 1) !== 0,
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

const numeric = (value: string): number | null => {
  const token = value.split(/\s+/u)[0];
  if (token === undefined || !/^(?:0x[a-fA-F0-9]+|\d+)$/u.test(token))
    return null;
  const parsed = Number.parseInt(token, token.startsWith("0x") ? 16 : 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

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
  const value = numberField(fields, name);
  return value === null ? null : `0x${value.toString(16)}`;
};

const stripOffsetSuffix = (value: string | null): string =>
  value?.replace(/\s+\(offset\s+\d+\)$/u, "") ?? "unknown";

const sectionAlignment = (exponent: number | null): number | null =>
  exponent === null || exponent > 52 ? null : 2 ** exponent;
