/** Caller-selected budgets the parser enforces while reading one container. */
export interface V8CodeCacheInputBudget {
  readonly max_strings: number;
  readonly min_string_bytes: number;
}
