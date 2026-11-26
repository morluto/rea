export interface ToolSummary {
  /** A 16-hex digest of each advertised schema, keyed `<kind> <profile>`. */
  readonly schemas: Readonly<Record<string, string>>;
  /** Patterns each schema kind advertises, sorted; empty kinds are omitted. */
  readonly patterns: Readonly<
    Partial<Record<"input" | "output", readonly string[]>>
  >;
}

export type CatalogSummary = Readonly<Record<string, ToolSummary>>;

export interface AdvertisedCatalog {
  readonly profile: { readonly input: string; readonly output: string };
  readonly tools: readonly {
    readonly name: string;
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
  }[];
}

export declare const summarizeAdvertisedCatalogs: (
  catalogs: readonly AdvertisedCatalog[],
  advertisedSchemaPatterns: (
    schema: unknown,
  ) => readonly { readonly pattern: string }[],
) => CatalogSummary;

export declare const toolSummaryFile: (name: string) => string;

export declare const serializeToolSummary: (summary: ToolSummary) => string;

export declare const describeSummaryChanges: (
  recorded: CatalogSummary,
  current: CatalogSummary,
) => string[];
