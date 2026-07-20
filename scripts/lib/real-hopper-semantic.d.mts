export interface FixtureProcedure {
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

export function analyzeFixtureProcedure(
  client: ToolClient,
  options: unknown,
  procedure: FixtureProcedure,
  normalizedResult: (value: unknown, operation: string) => unknown,
): Promise<unknown>;

interface NamedFixtureOptions {
  readonly client: ToolClient;
  readonly options: unknown;
  readonly target: { readonly path: string; readonly sha256: string };
  readonly expectations: Readonly<Record<string, readonly string[]>>;
  readonly normalizedResult: (value: unknown, operation: string) => any;
}

export function verifyNamedFixture(
  options: NamedFixtureOptions,
): Promise<unknown>;

export function verifyLanguageFixture(
  options: NamedFixtureOptions & {
    readonly operations: readonly string[];
    readonly semanticExpectations?: Readonly<Record<string, readonly string[]>>;
  },
): Promise<unknown>;

export function verifyAbsentFixtureValues(options: {
  readonly client: ToolClient;
  readonly options: unknown;
  readonly target: { readonly path: string; readonly sha256: string };
  readonly symbols?: readonly string[];
  readonly strings?: readonly string[];
  readonly normalizedResult: (value: unknown, operation: string) => any;
}): Promise<void>;
