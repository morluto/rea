import { verifyNoTokenOwnedProcesses } from "../../dist/process/ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "../../dist/process/ProcessOwnershipEvidence.js";
import {
  createSystemProcessOwnershipHost,
  readProcessOwnershipFacts,
} from "../../dist/process/ProcessOwnershipObservation.js";
import { readRunTokenCarriers } from "../../dist/process/ProcessRunTokenObservations.js";

/** Capture the prelaunch identities used by the canonical, PPID-independent sweep. */
export async function prepareVerifierTokenCleanup(run, suppliedHost) {
  const host = suppliedHost ?? createSystemProcessOwnershipHost();
  try {
    await host.prepare?.();
    const baseline = await host.captureBaseline?.();
    if (baseline === undefined)
      throw new Error("Verifier process ownership baseline is unavailable");
    const launcher = (await host.listProcesses()).find(
      ({ pid }) => pid === run.verifier_pid,
    );
    if (launcher === undefined)
      throw new Error("Verifier launcher is absent from the process snapshot");
    const relations = new Map();
    const retain = (runId, providerScope) => {
      if (typeof runId !== "string" || runId.length === 0)
        throw new Error("Provider run ownership receipt is unavailable");
      if (!relations.has(runId))
        relations.set(runId, {
          leaderPid: providerScope?.leaderPid ?? run.verifier_pid,
          processGroupId:
            providerScope?.processGroupId ?? launcher.processGroupId,
          ...(providerScope?.sampledProcessGroupIds === undefined
            ? {}
            : { sampledProcessGroupIds: providerScope.sampledProcessGroupIds }),
          evidenceOwner: new ProcessOwnershipEvidenceOwner(),
        });
    };
    retain(run.run_id);
    return {
      retainProviderRun: async (runId, providerScope) => {
        if (typeof runId !== "string" || runId.length === 0)
          throw new Error("Provider run ownership receipt is unavailable");
        if (runId === run.run_id)
          throw new Error(
            "Provider receipt must identify its own run, not the verifier run",
          );
        if (providerScope === undefined) {
          // Discovery proves presence only. Identity/token/identity reads then
          // establish scope anchors; the final canonical sweep proves cleanup.
          const carriers = await readRunTokenCarriers(host, runId);
          const facts = (
            await readProcessOwnershipFacts(carriers, host)
          ).filter(
            (fact) =>
              fact.state === "same-generation" &&
              fact.token.state === "readable" &&
              fact.token.runId === runId &&
              fact.identityAfter.state === "readable" &&
              fact.identityAfter.relation?.state === "observed",
          );
          if (facts.length === 0)
            throw new Error(
              `No token-verified process ownership for provider run ${runId}`,
            );
          providerScope = {
            leaderPid: facts[0].process.pid,
            processGroupId: facts[0].identityAfter.relation.processGroupId,
            sampledProcessGroupIds: [
              ...new Set(
                facts.map(
                  ({ identityAfter }) => identityAfter.relation.processGroupId,
                ),
              ),
            ],
          };
        }
        retain(runId, providerScope);
        const relation = relations.get(runId);
        const active = await verifyNoTokenOwnedProcesses(
          runId,
          host,
          baseline,
          relation,
        );
        if (relation.evidenceOwner.coverage.retainedOwned === 0)
          throw new Error(
            `No token-verified process ownership for provider run ${runId}: ${JSON.stringify(active)}`,
          );
      },
      verify: async () => {
        const runs = [];
        for (const [runId, relation] of relations) {
          runs.push({
            run_id: runId,
            result: await verifyNoTokenOwnedProcesses(
              runId,
              host,
              baseline,
              relation,
            ),
          });
        }
        const failed = runs.find(({ result }) => !result.cleaned);
        return {
          cleaned: failed === undefined,
          ...(failed === undefined ? {} : { reason: failed.result.reason }),
          runs,
        };
      },
      close: async () => {
        await host.close?.();
      },
    };
  } catch (cause) {
    await host.close?.();
    throw cause;
  }
}
