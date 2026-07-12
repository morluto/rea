/** Operator-approved roots, exclusions, and hard caps for source imports. */
export interface ReferenceSourcePolicy {
  readonly roots: readonly string[];
  readonly secretPatterns: readonly string[];
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxPathBytes: number;
}
