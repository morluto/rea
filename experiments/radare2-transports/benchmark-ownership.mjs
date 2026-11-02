// One helper and evidence ledger live for the complete Python benchmark trial.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { entrypointLifetime } from "./entrypoint-lifetime.mjs";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
} from "../../dist/process/ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "../../dist/process/ProcessOwnershipEvidence.js";
import {
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost as host,
} from "../../dist/process/ProcessOwnershipObservation.js";

const lifetime = entrypointLifetime();
let input;
let outputLost = false;
const disconnect = () => {
  input?.close();
  process.stdin.destroy();
};
lifetime.signal.addEventListener("abort", disconnect, { once: true });
process.stdout.on("error", () => {
  outputLost = true;
  disconnect();
});
process.stderr.on("error", () => {});
const send = (value) => {
  if (!outputLost) process.stdout.write(JSON.stringify(value) + "\n");
};
if (process.argv.length !== 2)
  throw new Error(
    "This helper requires a live benchmark session; manifests cannot restore ownership evidence",
  );
let ownership;
let cleaned = false;
let closed = false;
try {
  await prepareProcessOwnershipInspection();
  const selected = {
    runId: randomUUID(),
    expectedParentPid: process.ppid,
    sweepTokenOwnedProcesses: true,
    captureBaseline: await host.captureBaseline(),
  };
  const evidenceOwner = new ProcessOwnershipEvidenceOwner();
  ownership = { ...selected, evidenceOwner };
  send({ id: 0, ownership: selected });
  let previousId = 0;
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  if (lifetime.signal.aborted || outputLost) disconnect();
  for await (const line of lifetime.signal.aborted || outputLost ? [] : input) {
    let request;
    try {
      request = JSON.parse(line);
      if (!Number.isSafeInteger(request.id) || request.id <= previousId)
        throw new Error(
          "Request identity must increase within this helper session",
        );
      previousId = request.id;
      if (request.operation === "close") {
        if (ownership.leaderPid !== undefined && !cleaned)
          throw new Error(
            "Cleanup must be verified before closing this evidence owner",
          );
        await host.close?.();
        closed = true;
        send({ id: request.id, result: { closed: true } });
        break;
      }
      if (!["observe", "cleanup"].includes(request.operation))
        throw new Error("Expected observe, cleanup or close");
      if (!Number.isSafeInteger(request.leaderPid) || request.leaderPid <= 0)
        throw new Error("A launched child identity is required");
      if (
        ownership.leaderPid !== undefined &&
        ownership.leaderPid !== request.leaderPid
      )
        throw new Error("The trial's selected child cannot change");
      ownership.leaderPid = request.leaderPid;
      ownership.processGroupId = request.leaderPid;
      const result =
        request.operation === "cleanup"
          ? await cleanupOwnedProcessGroup(ownership, host)
          : await verifyNoTokenOwnedProcesses(
              ownership.runId,
              host,
              ownership.captureBaseline,
              ownership,
            );
      if (request.operation === "cleanup") cleaned = result.cleaned;
      send({
        id: request.id,
        result,
        evidence_coverage: evidenceOwner.coverage,
      });
    } catch (cause) {
      send({ id: request?.id ?? null, error: cause?.message ?? String(cause) });
    }
  }
} finally {
  // EOF, broken output and graceful signals cannot discard this private ledger.
  let reported = false;
  while (!closed) {
    try {
      if (ownership?.leaderPid !== undefined && !cleaned) {
        const result = await cleanupOwnedProcessGroup(ownership, host);
        if (!result.cleaned) throw new Error(result.reason);
        cleaned = true;
      }
      await host.close?.();
      closed = true;
    } catch (cause) {
      if (!reported)
        console.error(
          JSON.stringify({
            cleanup_pending: true,
            reason: cause?.message ?? String(cause),
          }),
        );
      reported = true;
      await delay(1_000);
    }
  }
}
