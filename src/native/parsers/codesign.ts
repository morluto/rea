import {
  inspectSignatureSchema,
  type InspectSignature,
} from "../../domain/nativeInspection.js";

/** Parse bounded `codesign -d` diagnostics, which Apple emits on stderr. */
export const parseCodeSignature = (
  output: string,
  unsigned: boolean,
): Omit<InspectSignature, "provenance"> => {
  const values = new Map<string, string>();
  const authorities: string[] = [];
  const cdhashes: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
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
    identifier: values.get("Identifier") ?? null,
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
  return /\bruntime\b/u.test(value);
};
