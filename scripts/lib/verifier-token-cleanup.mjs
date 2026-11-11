import { verifyNoTokenOwnedProcesses } from "../../dist/process/ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "../../dist/process/ProcessOwnershipEvidence.js";
import {
  createSystemProcessOwnershipHost,
  readProcessOwnershipFacts,
} from "../../dist/process/ProcessOwnershipObservation.js";
import { readRunTokenCarriers } from "../../dist/process/ProcessRunTokenObservations.js";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";

class VerifierOwnershipCleanupError extends AggregateError {
  constructor(firstFailure, retryFailure, cleanupOwner) {
    super(
      [firstFailure, retryFailure],
      "Verifier process ownership inspector cleanup is incomplete",
      { cause: firstFailure },
    );
    this.name = "VerifierOwnershipCleanupError";
    this.cleanupOwner = cleanupOwner;
  }
}

/** Capture the prelaunch identities used by the canonical, PPID-independent sweep. */
export async function prepareVerifierTokenCleanup(run, suppliedHost) {
  const host = suppliedHost ?? createSystemProcessOwnershipHost();
  const close = async () => {
    try {
      await host.close?.();
    } catch (firstFailure) {
      // Retry the native reader's retained helper and cache ownership.
      try {
        await host.close?.();
      } catch (retryFailure) {
        throw new VerifierOwnershipCleanupError(
          firstFailure,
          retryFailure,
          host,
        );
      }
      throw firstFailure;
    }
  };
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
    const relations = new Map([
      [
        run.run_id,
        {
          leaderPid: run.verifier_pid,
          processGroupId: launcher.processGroupId,
          evidenceOwner: new ProcessOwnershipEvidenceOwner(),
        },
      ],
    ]);
    return {
      registerProviderRun: (runId) => {
        if (typeof runId !== "string" || runId.length === 0)
          throw new Error("Provider run ownership receipt is unavailable");
        if (runId === run.run_id)
          throw new Error(
            "Provider receipt must identify its own run, not the verifier run",
          );
        if (relations.has(runId))
          throw new Error(`Provider run ${runId} is already registered`);
        // The run can be known before its lazy launcher starts. An unscoped
        // canonical sweep checks its token without assuming wrapper ancestry.
        relations.set(runId, undefined);
      },
      retainProviderRun: async (runId, providerScope) => {
        if (!relations.has(runId) || runId === run.run_id)
          throw new Error(`Provider run ${runId} was not registered`);
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
        const relation = relations.get(runId) ?? {
          ...providerScope,
          evidenceOwner: new ProcessOwnershipEvidenceOwner(),
        };
        relations.set(runId, relation);
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
      close,
    };
  } catch (cause) {
    return withVerifierCleanup(() => {
      throw cause;
    }, [close]);
  }
}
