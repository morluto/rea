/**
 * A CLI error output with each input issue's leading CLI key spelled as its
 * contract field, so one expectation can cover the CLI and MCP adapters.
 * An issue that names the contract field instead of its CLI key throws.
 */
export const issuesByContractField = (
  output: unknown,
  contractFieldByCliKey: Readonly<Record<string, string>>,
): unknown => {
  if (typeof output !== "object" || output === null) return output;
  const { details } = output as { readonly details?: unknown };
  if (typeof details !== "object" || details === null) return output;
  const { issues } = details as { readonly issues?: unknown };
  if (!Array.isArray(issues)) return output;
  return {
    ...output,
    details: {
      ...details,
      issues: issues.map((issue: unknown) => {
        const path = (issue as { readonly path?: unknown }).path;
        if (!Array.isArray(path) || typeof path[0] !== "string") return issue;
        if (Object.values(contractFieldByCliKey).includes(path[0]))
          throw new Error(`CLI issue names contract field ${path[0]}`);
        const field = contractFieldByCliKey[path[0]];
        return field === undefined
          ? issue
          : { ...(issue as object), path: [field, ...path.slice(1)] };
      }),
    },
  };
};
