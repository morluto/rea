import { openRecordedCrashSession } from "./public.mjs";
import { withVerifierCleanup } from "../../lib/verifier-cleanup.mjs";
import assert from "node:assert/strict";

const session = openRecordedCrashSession({
  entrypoint: process.argv[2],
  environment: process.env,
});
// The session is owned before it connects, and a refused close is retained
// beside the connection or inspection failure instead of replacing it.
await withVerifierCleanup(async () => {
  await session.connect();
  const report = await session.inspect("mcp", process.argv[3], {
    debuggerContext: true,
  });
  const historicalPid = Number(process.argv[4]);
  assert.ok(
    report.threads.some((thread) => thread.historical_pid === historicalPid),
    "MCP must decode the selected historical-PID control before its trace qualifies",
  );
}, [() => session.close()]);
