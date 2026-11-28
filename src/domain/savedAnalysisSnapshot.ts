/** Receipt for an atomically published analysis snapshot. */
export interface SavedAnalysisSnapshot {
  readonly path: string;
  readonly bytes: number;
  /** Eligible primitive query bindings. */
  readonly primitive_entries: number;
  /** Eligible composed workflow bindings, separate from primitive queries. */
  readonly workflow_entries: number;
  /** Includes retained observations without a replay binding. */
  readonly evidence_records: number;
}
