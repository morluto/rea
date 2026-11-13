// A host deadline can discard the response before error remediation reaches the
// agent. Teach that distinction at initialization, not just in returned errors.
const RECOVERY_START =
  "Recovery: Correct malformed arguments from the reported fields and connected schema; refresh tools/list only if stale. Do not repeat unchanged failures. A valid unresolved lookup is not an argument error or a completed reference search. Follow returned remediation for REA provider_timeout and resource errors; reuse partial Evidence. ";
const RUNTIME_SETTINGS_RECOVERY =
  "When an error names an editable setting and bounds, call update_analysis_settings directly; inspection is optional when those facts are supplied.";
const LAUNCH_SETTINGS_RECOVERY =
  "For an editable launch setting, follow the error's restart instructions; add application to REA_MCP_TOOL_FAMILIES and restart to enable runtime settings tools.";
const EXPLICIT_ARGUMENT_RECOVERY =
  " Explicit per-call arguments override runtime defaults. Change only the recommended control, then retry after work and cleanup settle. Runtime updates affect new work and do not clear cleanup blockers.";
const RECOVERY_END =
  " A host timeout without a REA result is a client deadline, not proof that work or cleanup stopped; session status cannot establish completion of all target-free work. Do not replay uncertain analysis. Increase the client deadline with execution/cleanup/delivery headroom, or report the needed change (Codex: mcp_servers.<server>.tool_timeout_sec, seconds). Server analysis_timeout_ms is a separate millisecond budget and cannot fix a shorter client deadline. Keep the connection for reported cleanup retries. After a connection/startup failure, retry once only if safe or known not to have started. If it persists, ask the user to restart the MCP client; run rea doctor if REA cannot start or tools remain missing. Preserve needed Evidence before restarting REA.";

/** Only direct callers to runtime settings tools when they are advertised. */
export const recoveryInstructions = (
  runtimeSettingsAvailable: boolean,
): string =>
  `${RECOVERY_START}${runtimeSettingsAvailable ? RUNTIME_SETTINGS_RECOVERY : LAUNCH_SETTINGS_RECOVERY}${EXPLICIT_ARGUMENT_RECOVERY}${RECOVERY_END}`;

/** Recovery when a scoped session cannot advertise the target lifecycle. */
export const SCOPED_NO_TARGET_RECOVERY =
  "No target is open, and this MCP connection does not advertise open_binary. Preserve needed outputs before restarting; retained in-memory Evidence and Unknown history will not carry over. Add session to REA_MCP_TOOL_FAMILIES in the environment that starts REA and restart the server; then call open_binary with the chosen local path.";
