/** Finite allowance for conformance workflows that resend complete Evidence.
 * Admission-policy regressions exercise the production default separately.
 * @type {{ readonly REA_MCP_MAX_INPUT_ELEMENTS: "65536" }}
 */
export const INLINE_EVIDENCE_MCP_ENVIRONMENT = Object.freeze({
  REA_MCP_MAX_INPUT_ELEMENTS: "65536",
});
