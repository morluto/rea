/** Finite allowance for conformance workflows that resend complete Evidence.
 * These workflows read complete Evidence from tools whose omitted detail is
 * budgeted, so the agent result budget is raised to its maximum.
 * Admission-policy and delivery-budget regressions exercise the production
 * defaults separately.
 */
export const INLINE_EVIDENCE_MCP_ENVIRONMENT = Object.freeze({
  REA_MCP_MAX_INPUT_ELEMENTS: "65536",
  REA_AGENT_RESULT_BUDGET_BYTES: String(10 * 1024 * 1024),
});
