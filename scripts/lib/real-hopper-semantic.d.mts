interface FixtureProcedure {
  readonly address: string;
  readonly name: string;
}

interface ToolClient {
  callTool(
    request: { readonly name: string; readonly arguments: unknown },
    options: unknown,
  ): Promise<unknown>;
}

export function resolveFixtureProcedure(
  client: ToolClient,
  options: unknown,
  expectedName: string,
  normalizedResult: (value: unknown, operation: string) => unknown,
): Promise<FixtureProcedure>;

export function requireSafeDiagnostics(chunks: readonly string[]): number;

export function requireCurrentDocument(
  client: ToolClient,
  options: unknown,
  documents: readonly string[],
  normalizedResult: (value: unknown, operation: string) => unknown,
): Promise<string>;

export function verifyRealHopperFixture(options: {
  readonly client: ToolClient;
  readonly options: unknown;
  readonly document: string;
  readonly oracle: {
    readonly mainProcedure: string;
    readonly entryProcedure: string;
    readonly branchProcedure: string;
    readonly leafProcedure: string;
    readonly entryString: string;
    readonly leafString: string;
    readonly globalName: string;
  };
  readonly normalizedResult: (value: unknown, operation: string) => unknown;
}): Promise<{
  readonly procedures: Readonly<
    Record<"main" | "entry" | "branch" | "leaf", FixtureProcedure>
  >;
  readonly entryComments: number;
  readonly entryStrings: number;
  readonly entryCallees: number;
  readonly branchCallees: number;
  readonly branchBlocks: number;
  readonly leafStrings: number;
  readonly leafNames: number;
}>;
