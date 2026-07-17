/** A caller-visible page whose total population is known exactly. */
export interface KnownCollectionPage<Item> {
  readonly items: readonly Item[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly returned: number;
  readonly complete: boolean;
}

/** Fail-closed completeness derived from a known-total source page. */
export interface KnownPageCoverageAssessment {
  readonly complete: boolean;
  readonly sourceComplete: boolean;
  readonly includedCount: number;
  readonly omittedCount: number;
  readonly sourceOmittedCount: number;
}

/**
 * Assess source-page and downstream-projection completeness without treating an
 * unreturned row as absent. `includedCount` is the number retained downstream.
 */
export const assessKnownPageCoverage = <Item>(
  page: KnownCollectionPage<Item>,
  includedCount: number = page.items.length,
): KnownPageCoverageAssessment => {
  const observedCount = Math.min(page.total, page.returned, page.items.length);
  const retainedCount = Math.min(
    observedCount,
    Math.max(0, Math.floor(includedCount)),
  );
  const sourceOmittedCount = Math.max(0, page.total - observedCount);
  const sourceComplete =
    page.complete &&
    page.offset === 0 &&
    page.returned === page.total &&
    sourceOmittedCount === 0;
  const omittedCount = Math.max(0, page.total - retainedCount);
  return {
    complete: sourceComplete && omittedCount === 0,
    sourceComplete,
    includedCount: retainedCount,
    omittedCount,
    sourceOmittedCount,
  };
};
