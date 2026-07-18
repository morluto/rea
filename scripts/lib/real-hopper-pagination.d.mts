interface ToolClient {
  callTool(request: unknown, options: unknown): Promise<unknown>;
}

interface PaginationSummary {
  readonly count: number;
  readonly pages: number;
}

export function verifyLargeFixturePagination(input: {
  readonly client: ToolClient;
  readonly options: unknown;
  readonly normalizedResult: (value: unknown, operation: string) => unknown;
  readonly expectedCount: number;
  readonly symbolPrefix: string;
  readonly stringPrefix: string;
}): Promise<{
  readonly procedures: PaginationSummary;
  readonly strings: PaginationSummary;
}>;

export function openAndVerifyLargeFixture(input: {
  readonly client: ToolClient;
  readonly options: unknown;
  readonly normalizedResult: (value: unknown, operation: string) => unknown;
  readonly path: string;
  readonly expectedCount: number;
  readonly symbolPrefix: string;
  readonly stringPrefix: string;
}): Promise<{
  readonly procedures: PaginationSummary;
  readonly strings: PaginationSummary;
}>;
