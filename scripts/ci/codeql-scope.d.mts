export type CodeqlLanguage = "javascript-typescript" | "python" | "actions";

export interface CodeqlScopeRequest {
  readonly event: string | undefined;
  readonly base: string | undefined;
  readonly head: string | undefined;
}

export interface CodeqlScopeRepository {
  readonly mergeBase: (base: string, head: string) => string;
  readonly changedFiles: (base: string, head: string) => readonly string[];
}

export interface CodeqlScopePlan {
  readonly run: boolean;
  readonly languages: readonly CodeqlLanguage[];
  readonly reason: string;
}

export const CODEQL_LANGUAGES: readonly CodeqlLanguage[];

export function planCodeqlLanguages(
  request: CodeqlScopeRequest,
  repository: CodeqlScopeRepository,
): CodeqlScopePlan;
