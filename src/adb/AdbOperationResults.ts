import { createAnalysisExecution } from "../ports/AnalysisProvider.js";
import type { AdbUnparsedLines } from "./AdbUnparsedLines.js";
import type {
  AdbBinarySelection,
  AdbClientIdentity,
} from "./AdbConfiguration.js";

export const clientIdentityResult = (
  selection: AdbBinarySelection,
  identity: AdbClientIdentity,
) => ({
  binary_path: selection.binary,
  path_source: selection.pathSource,
  version: identity.version,
  installed_path: identity.installedPath,
});

export type AdbClientResult = ReturnType<typeof clientIdentityResult>;
export type AdbProviderIdentity = {
  id: string;
  name: string;
  version: string | null;
};

/** Slice a parsed listing by optional caller-selected offset and limit. */
export const pageListingItems = <T>(
  items: readonly T[],
  label: string,
  paging: {
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  },
): {
  readonly items: T[];
  readonly truncated: boolean;
  readonly limitations: readonly string[];
} => {
  const offset = paging.offset ?? 0;
  const sliced = items.slice(
    offset,
    paging.limit === undefined ? undefined : offset + paging.limit,
  );
  const truncated = sliced.length < items.length;
  const limitations = truncated
    ? [
        `Returned ${String(sliced.length)} of ${String(items.length)} ${label} (offset ${String(offset)}${paging.limit === undefined ? "" : `, limit ${String(paging.limit)}`}); adjust offset or limit to read remaining entries.`,
      ]
    : [];
  return { items: sliced, truncated, limitations };
};

/**
 * Build a parsed-listing execution whose `unparsed_lines`, coverage, and
 * truncation limitation all derive from the parser's unrecognized-line facts,
 * so the limitation can never describe a field the result does not carry.
 */
export const parsedListingExecution = (
  result: Readonly<Record<string, unknown>>,
  unparsed: AdbUnparsedLines,
  provider: AdbProviderIdentity,
  limitations: readonly string[] = [],
  partial = false,
) =>
  createAnalysisExecution(
    {
      ...result,
      unparsed_lines: unparsed.sample,
      coverage: unparsed.total > 0 || partial ? "partial" : "complete",
    },
    provider,
    {
      limitations: [
        ...limitations,
        ...(unparsed.total > unparsed.sample.length
          ? [
              `unparsed_lines reports the first ${String(unparsed.sample.length)} of ${String(unparsed.total)} unrecognized lines`,
            ]
          : []),
      ],
    },
  );
