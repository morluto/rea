import { readdir } from "node:fs/promises";

import type { TargetFailureKind } from "../../../src/domain/targetFailure.js";

/**
 * One case of a reader's target-failure contract: bytes the reader must
 * refuse with `kind`, and the owner facts the refusal must carry.
 */
export interface TargetFailureCase {
  /** A short name that is unique within its reader entry. */
  readonly name: string;
  readonly kind: TargetFailureKind;
  readonly bytes: () => Buffer;
  /** Owner facts the refusal reports, such as `format`, `offset` or `field`. */
  readonly facts?: Readonly<Record<string, string | number>>;
  /** Extra arguments after the path, as CLI flags and as MCP arguments. */
  readonly cli?: readonly string[];
  readonly mcp?: Readonly<Record<string, unknown>>;
  /**
   * Whether the refusal keeps the completed file identity. Readers that
   * refuse before they hash the file report none.
   */
  readonly identity: boolean;
}

/** Every case one public operation must pass, through both adapters. */
export interface TargetFailureReader {
  /** The MCP tool name; the CLI command is its kebab-case spelling. */
  readonly operation: string;
  readonly cases: readonly TargetFailureCase[];
}

/**
 * Register readers from one area. Each area owns a module in `readers/`, so
 * adding a reader never edits a shared table.
 */
export const targetFailureReaders = (
  readers: readonly TargetFailureReader[],
): readonly TargetFailureReader[] => readers;

const READERS = new URL("./readers/", import.meta.url);

/** Every registered reader, from every area module, in a stable order. */
export const loadTargetFailureReaders = async (): Promise<
  readonly TargetFailureReader[]
> => {
  const modules = (await readdir(READERS))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  const readers: TargetFailureReader[] = [];
  for (const name of modules) {
    const module = (await import(new URL(name, READERS).href)) as {
      readonly default?: readonly TargetFailureReader[];
    };
    if (module.default === undefined)
      throw new Error(`Target failure module ${name} has no default export`);
    readers.push(...module.default);
  }
  const seen = new Set<string>();
  for (const { operation, cases } of readers)
    for (const { name } of cases) {
      const key = `${operation}/${name}`;
      if (seen.has(key)) throw new Error(`Duplicate conformance case ${key}`);
      seen.add(key);
    }
  return readers;
};
