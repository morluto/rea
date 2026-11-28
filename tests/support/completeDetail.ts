/**
 * CLI arguments that request complete Evidence inline. Workflows that read
 * complete Evidence from a tool whose omitted detail is budgeted ask for it
 * with these, instead of relying on the agent result budget.
 */
export const COMPLETE_DETAIL = ["--detail", "complete"] as const;

/** `rea <command> <path>` argv with complete Evidence as JSON. */
export const completeArguments = (command: string, path: string): string[] => [
  command,
  ...COMPLETE_DETAIL,
  path,
  "--json",
];

/** `rea analyze-javascript-application <path>` with complete Evidence as JSON. */
export const completeApplicationAnalysis = (path: string): string[] =>
  completeArguments("analyze-javascript-application", path);
