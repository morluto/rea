/** Validated accumulation of native Grok discovery pages. */
export class GrokCatalogDiscovery {
  constructor(expectedNames: readonly string[]);
  readonly pages: readonly unknown[];
  readonly size: number;
  accept(discovery: unknown, query: string): string | undefined;
}
