import {
  inspectSignatureSchema,
  type InspectSignature,
} from "../../domain/native/nativeInspection.js";

/**
 * Parse bounded `codesign -d --verbose=4` diagnostics, which Apple emits on
 * stderr. codesign echoes the executable path and signing identifier
 * verbatim, and an ad hoc identifier derives from the file name, so either
 * can contain line breaks and text that resembles other fields. The path is
 * removed by its exact value from `executablePaths`, and the identifier runs
 * to the `Format=` field that codesign prints after it.
 */
export const parseCodeSignature = (
  output: string,
  unsigned: boolean,
  executablePaths: readonly string[] = [],
): Omit<InspectSignature, "provenance"> => {
  const { identifier, fields } = splitEchoedValues(
    output.replaceAll("\r\n", "\n"),
    executablePaths,
  );
  const values = new Map<string, string>();
  const authorities: string[] = [];
  const cdhashes: string[] = [];
  for (const line of fields.split("\n")) {
    if (line.startsWith("CodeDirectory ")) {
      values.set("CodeDirectory", line.slice("CodeDirectory ".length));
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "Authority") authorities.push(value);
    else if (key === "CDHash") cdhashes.push(value);
    else values.set(key, value);
  }
  const parsed = inspectSignatureSchema.omit({ provenance: true }).parse({
    signed: !unsigned,
    identifier: identifier ?? null,
    team_identifier: nullableCodeSignValue(values.get("TeamIdentifier")),
    format: values.get("Format") ?? null,
    cdhashes,
    hash_algorithms: splitAlgorithms(values.get("Hash choices")),
    authorities,
    designated_requirement: values.get("designated") ?? null,
    entitlements: null,
    timestamp: values.get("Timestamp") ?? null,
    hardened_runtime: parseRuntime(values.get("CodeDirectory")),
    limitations: unsigned
      ? ["Artifact is not signed."]
      : [
          "Entitlements and designated requirements require separate bounded commands.",
        ],
  });
  return parsed;
};

/**
 * Separate the echoed executable path and signing identifier, which codesign
 * prints first, from the fields that follow them.
 */
const splitEchoedValues = (
  text: string,
  executablePaths: readonly string[],
): { readonly identifier: string | undefined; readonly fields: string } => {
  const executable = executablePaths
    .map((path) => `Executable=${path}\n`)
    .find((line) => text.startsWith(line));
  let rest = text;
  if (executable !== undefined) rest = text.slice(executable.length);
  else if (text.startsWith("Executable=")) {
    const identifierLine = text.indexOf("\nIdentifier=");
    rest = identifierLine < 0 ? text : text.slice(identifierLine + 1);
  }
  if (!rest.startsWith("Identifier="))
    return { identifier: undefined, fields: rest };
  // Later fields come from the signature itself, so the last `Format=` line
  // is the one codesign printed after the identifier.
  const format = rest.lastIndexOf("\nFormat=");
  const lineEnd = rest.indexOf("\n");
  const end = format >= 0 ? format : lineEnd >= 0 ? lineEnd : rest.length;
  return {
    identifier: rest.slice("Identifier=".length, end),
    fields: rest.slice(end),
  };
};

const nullableCodeSignValue = (value: string | undefined): string | null =>
  value === undefined || value === "not set" ? null : value;

const splitAlgorithms = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(/[,+\s]+/u)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

const parseRuntime = (value: string | undefined): boolean | null => {
  if (value === undefined) return null;
  const flags = /(?:^|\s)flags=[^(]*\(([^)]*)\)/u.exec(value)?.[1];
  if (flags === undefined) return null;
  return flags.split(",").some((flag) => flag.trim() === "runtime");
};
