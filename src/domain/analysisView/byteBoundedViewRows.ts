import type { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import type { JsonValue } from "../jsonValue.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import { ok, type Result } from "../result.js";
import {
  ANALYSIS_VIEW_PAGE_BYTES as PAGE_BYTES,
  analysisViewPageTooLarge,
} from "./analysisViewErrors.js";

/** Bytes the view digest adds after projection. */
const DIGEST_BYTES = jsonValueByteLength({ view_digest: "0".repeat(64) }) - 1;

/** The widest page coverage, for measuring a page envelope before its rows. */
export const PLACEHOLDER_COVERAGE = {
  status: "page",
  examined: Number.MAX_SAFE_INTEGER,
  total: Number.MAX_SAFE_INTEGER,
  next_offset: Number.MAX_SAFE_INTEGER,
  exhausted: false,
} as const;

/** A page of rows, the number of matching rows, and whether bytes ended it early. */
export interface ByteBoundedRows<Row> {
  readonly rows: Row[];
  readonly total: number;
  /** Rows after these fit `limit` but not the analysis-view page bytes. */
  readonly byte_limited: boolean;
}

/** How a byte-bounded page names itself when one row cannot fit. */
export interface ByteBoundedPageOwner {
  readonly parentEvidenceId: string;
  /** The page result without its rows, measured once as the page's fixed cost. */
  readonly envelope: JsonValue;
  readonly facet: string;
}

/**
 * Select rows from `offset` up to `limit` that fit the analysis-view page
 * bytes beside `owner.envelope`. A row that does not fit ends the page with
 * byte_limited, so the next offset continues after the last returned row; a
 * first row that cannot fit alone is refused, naming the parent. Without
 * `matches`, only the page's rows are visited, and `project` runs only on
 * rows the page returns.
 */
export const selectByteBoundedViewRows = <Source, Row>(
  rows: readonly Source[],
  view: { readonly offset: number; readonly limit: number },
  {
    matches,
    project,
  }: {
    readonly matches: ((row: Source, index: number) => boolean) | undefined;
    readonly project: (row: Source, index: number) => Row;
  },
  owner: ByteBoundedPageOwner,
): Result<ByteBoundedRows<Row>, AnalysisResourceConstraintError> => {
  const tooLarge = () =>
    analysisViewPageTooLarge(
      owner.parentEvidenceId,
      `One ${owner.facet} row exceeds the analysis-view page bytes on its own. Complete parent Evidence remains retained; select complete detail or export the Evidence bundle to read it.`,
      { facet: owner.facet },
    );
  let bytes =
    DIGEST_BYTES +
    jsonValueByteLength(owner.envelope, PAGE_BYTES - DIGEST_BYTES);
  if (bytes > PAGE_BYTES) return tooLarge();
  const selected: Row[] = [];
  let byteLimited = false;
  /** Admit one projected row, or end the page; false refuses the page. */
  const admit = (row: Row): boolean => {
    const size =
      jsonValueByteLength(row as unknown as JsonValue, PAGE_BYTES - bytes) +
      Number(selected.length > 0);
    if (bytes + size > PAGE_BYTES) {
      if (selected.length === 0) return false;
      byteLimited = true;
      return true;
    }
    bytes += size;
    selected.push(row);
    return true;
  };
  if (matches === undefined) {
    const start = Math.min(view.offset, rows.length);
    const end = Math.min(rows.length, start + view.limit);
    for (let index = start; index < end && !byteLimited; index += 1)
      if (!admit(project(rows[index]!, index))) return tooLarge();
    return ok({
      rows: selected,
      total: rows.length,
      byte_limited: byteLimited,
    });
  }
  let total = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!matches(row, index)) continue;
    if (total >= view.offset && selected.length < view.limit && !byteLimited)
      if (!admit(project(row, index))) return tooLarge();
    total++;
  }
  return ok({ rows: selected, total, byte_limited: byteLimited });
};
