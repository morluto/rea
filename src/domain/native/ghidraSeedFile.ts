import { ConfigurationError } from "../configurationErrors.js";
import { err, ok, type Result } from "../result.js";

/**
 * The `REA_GHIDRA_SEED_FILE` text format: `address<TAB>kind[<TAB>name]`
 * lines that Ghidra applies before analysis. il2cpp writes these files and
 * the Ghidra provider reads them, so the format and its limits live here.
 */
export const MAX_GHIDRA_SEED_BYTES = 32 * 1024 * 1024;
export const MAX_GHIDRA_SEED_ENTRIES = 1_000_000;
export const MAX_GHIDRA_SEED_NAME_LENGTH = 2000;

export type GhidraSeedKind = "function" | "code" | "label";
export interface GhidraSeedEntry {
  readonly address: bigint;
  readonly kind: GhidraSeedKind;
  readonly name?: string;
}

/** A configuration error naming one seed file line. */
export const ghidraSeedLineError = (line: number, constraint: string) =>
  new ConfigurationError("Invalid REA environment configuration", {
    settings: [
      {
        setting: "REA_GHIDRA_SEED_FILE",
        constraint: `line ${line}: ${constraint}`,
      },
    ],
  });

/**
 * Parse `address<TAB>kind[<TAB>name]` lines. Blank lines and `#` comments are
 * ignored. Addresses are hexadecimal offsets in the default address space.
 */
export const parseGhidraSeeds = (
  text: string,
): Result<readonly GhidraSeedEntry[], ConfigurationError> => {
  const entries: GhidraSeedEntry[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "" || line.startsWith("#")) continue;
    const number = index + 1;
    const fields = line.split("\t");
    if (fields.length < 2 || fields.length > 3)
      return err(
        ghidraSeedLineError(number, "expected address<TAB>kind[<TAB>name]"),
      );
    const [address, kind, name] = fields;
    if (address === undefined || !/^0x[0-9a-fA-F]{1,16}$/u.test(address))
      return err(
        ghidraSeedLineError(number, "address must be 0x-prefixed hex"),
      );
    if (kind !== "function" && kind !== "code" && kind !== "label")
      return err(
        ghidraSeedLineError(number, "kind must be function, code or label"),
      );
    if (
      name !== undefined &&
      (name.length === 0 ||
        name.length > MAX_GHIDRA_SEED_NAME_LENGTH ||
        /[\s\0]/u.test(name))
    )
      return err(
        ghidraSeedLineError(
          number,
          `name must be 1..${MAX_GHIDRA_SEED_NAME_LENGTH} characters without whitespace`,
        ),
      );
    if (kind === "label" && name === undefined)
      return err(ghidraSeedLineError(number, "a label seed requires a name"));
    if (kind === "code" && name !== undefined)
      return err(
        ghidraSeedLineError(
          number,
          "a code seed takes no name; add a label seed",
        ),
      );
    const value = BigInt(address);
    const key = `${value.toString(16)}:${kind}`;
    if (seen.has(key))
      return err(
        ghidraSeedLineError(number, `duplicate ${kind} seed at ${address}`),
      );
    seen.add(key);
    entries.push({
      address: value,
      kind,
      ...(name === undefined ? {} : { name }),
    });
    if (entries.length > MAX_GHIDRA_SEED_ENTRIES)
      return err(
        ghidraSeedLineError(
          number,
          `more than ${MAX_GHIDRA_SEED_ENTRIES} seed entries`,
        ),
      );
  }
  return ok(entries);
};

/** Canonical script input: lowercase addresses, fixed field order, LF endings. */
export const normalizedGhidraSeeds = (
  entries: readonly GhidraSeedEntry[],
): string =>
  entries
    .map(
      (entry) =>
        `0x${entry.address.toString(16)}\t${entry.kind}${entry.name === undefined ? "" : `\t${entry.name}`}\n`,
    )
    .join("");
