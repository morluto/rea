import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { verifyNoTokenOwnedProcesses } from "../../dist/process/ProcessOwnership.js";
import {
  observeProcessStartIdentity,
  signalProcessWithStartIdentity,
} from "../../dist/process/ProcessOwnershipObservation.js";
import { startUnrelatedHopperSentinel } from "./unrelated-hopper-sentinel.mjs";
import {
  requireMcpEvidenceResult,
  requireMcpLifecycleResult,
} from "./mcp-verifier-results.mjs";

const execFileAsync = promisify(execFile);

/** Prove actual MCP owner exit releases the demo singleton for subsequent CLI/MCP sessions. */
export async function verifyLinuxHopperOwnerExit({
  primary,
  secondary,
  serverCommand,
  serverArgs,
  environment,
}) {
  const sentinel = await startUnrelatedHopperSentinel();
  const outcomes = [];
  try {
    for (const mode of ["graceful", "SIGKILL"]) {
      const transport = new StdioClientTransport({
        command: serverCommand,
        args: serverArgs,
        env: environment,
        stderr: "pipe",
      });
      // Drain launcher diagnostics even on the deliberately interrupted owner.
      transport.stderr?.resume();
      const client = new Client({ name: "hopper-owner-exit", version: "1" });
      const options = { timeout: 180_000 };
      try {
        await client.connect(transport);
        const ownerPid = transport.pid;
        assert.ok(ownerPid !== null);
        const owner = await observeProcessStartIdentity(ownerPid);
        assert.equal(owner?.state, "readable");
        requireMcpLifecycleResult(
          await client.callTool(
            {
              name: "open_binary",
              arguments: { path: primary },
            },
            options,
          ),
          "open_binary",
        );
        const procedures = requireMcpEvidenceResult(
          await client.callTool(
            { name: "list_procedures", arguments: {} },
            options,
          ),
          "list_procedures",
        );
        assert.ok(procedures.length > 0);
        const status = requireMcpLifecycleResult(
          await client.callTool(
            { name: "binary_session", arguments: {} },
            options,
          ),
          "binary_session",
        );
        const runId = status.analysis_run?.run_id;
        assert.equal(typeof runId, "string");
        assert.equal(status.analysis_provider_binding?.provider.id, "hopper");
        assert.equal((await verifyNoTokenOwnedProcesses(runId)).cleaned, false);
        if (mode === "graceful") await client.close();
        else {
          assert.equal(
            await signalProcessWithStartIdentity(
              ownerPid,
              owner.identity,
              "SIGKILL",
            ),
            "signaled",
          );
        }
        const deadline = Date.now() + 10_000;
        let cleanup;
        do {
          cleanup = await verifyNoTokenOwnedProcesses(runId);
          if (cleanup.cleaned) break;
          await delay(100);
        } while (Date.now() < deadline);
        assert.equal(cleanup.cleaned, true, cleanup.reason);
        // The SIGKILL case must recover the stale lease for both target identities.
        for (const target of [primary, secondary]) {
          const result = await execFileAsync(
            process.execPath,
            [
              "scripts/rea.mjs",
              "inspect",
              target,
              "--provider",
              "hopper",
              "--format",
              "json",
            ],
            { env: environment, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
          );
          assert.ok(JSON.parse(result.stdout).normalized_result);
        }
        outcomes.push({
          mode,
          ownedProcessesStopped: true,
          sameTargetReopened: true,
          differentTargetReopened: true,
        });
      } finally {
        await client.close();
        await transport.close();
      }
    }
  } finally {
    assert.equal(await sentinel.verifyAndClose(), true);
  }
  return { outcomes, unrelatedHopperSurvived: true };
}
