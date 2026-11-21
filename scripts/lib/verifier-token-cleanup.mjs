import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
} from "../../dist/process/ProcessOwnership.js";
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
    const discoverProviderScope = async (runId) => {
      // A token carrier selects candidates; native identity and membership
      // must agree across the token observation before anchoring a scope.
      const carriers = await readRunTokenCarriers(host, runId);
      const facts = (await readProcessOwnershipFacts(carriers, host)).filter(
        (fact) =>
          fact.state === "same-generation" &&
          fact.token.state === "readable" &&
          fact.token.runId === runId &&
          fact.identityAfter.state === "readable" &&
          fact.identityAfter.relation?.state === "observed" &&
          !baseline.some(
            ({ pid, identity }) =>
              pid === fact.process.pid &&
              identity === fact.identityAfter.identity,
          ),
      );
      const first = facts[0];
      if (first === undefined) return undefined;
      return {
        leaderPid: first.process.pid,
        processGroupId: first.identityAfter.relation.processGroupId,
        sampledProcessGroupIds: [
          ...new Set(
            facts.map(
              ({ identityAfter }) => identityAfter.relation.processGroupId,
            ),
          ),
        ],
      };
    };
    const retainRelation = (runId, scope) => {
      const relation = relations.get(runId) ?? {
        ...scope,
        evidenceOwner: new ProcessOwnershipEvidenceOwner(),
      };
      relations.set(runId, relation);
      return relation;
    };
    const cleanupHost = {
      ...host,
      signalGroup: (groupId, signal) => {
        if (groupId === launcher.processGroupId)
          throw new Error("Provider recovery cannot signal the verifier group");
        host.signalGroup(groupId, signal);
      },
    };
    const cleanup = {
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
        const scope = providerScope ?? (await discoverProviderScope(runId));
        if (scope === undefined)
          throw new Error(
            `No token-verified process ownership for provider run ${runId}`,
          );
        const relation = retainRelation(runId, scope);
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
      retryProviderCleanup: async (verification) => {
        const runs = [];
        for (const { run_id: runId, result } of verification.runs) {
          if (result.cleaned || runId === run.run_id || !relations.has(runId))
            continue;
          try {
            const scope =
              host.processIdentities === undefined
                ? undefined
                : (relations.get(runId) ??
                  (await discoverProviderScope(runId)));
            const retry =
              scope === undefined
                ? await verifyNoTokenOwnedProcesses(runId, host, baseline)
                : await cleanupOwnedProcessGroup(
                    {
                      ...retainRelation(runId, scope),
                      runId,
                      captureBaseline: baseline,
                      sweepTokenOwnedProcesses: true,
                    },
                    cleanupHost,
                  );
            runs.push({ run_id: runId, result: retry });
          } catch (cause) {
            runs.push({
              run_id: runId,
              result: {
                cleaned: false,
                reason: cause instanceof Error ? cause.message : String(cause),
              },
            });
          }
        }
        return { cleaned: runs.every(({ result }) => result.cleaned), runs };
      },
      retainPendingProviderCleanup: (verification) => {
        let pending = verification;
        let closing;
        const owner = {
          close: () => {
            closing ??= (async () => {
              if (!pending.cleaned) {
                pending = await cleanup.retryProviderCleanup(pending);
                if (!pending.cleaned)
                  throw Object.assign(
                    new Error("Verifier provider cleanup is still incomplete"),
                    { verification: pending },
                  );
              }
              await close();
            })().catch((cause) => {
              closing = undefined;
              throw Object.assign(
                new Error("Retained verifier cleanup is incomplete", { cause }),
                { cleanupOwner: owner },
              );
            });
            return closing;
          },
        };
        return owner;
      },
      retainedProviderEvidence: () =>
        [...relations].flatMap(([runId, relation]) =>
          runId === run.run_id || relation === undefined
            ? []
            : [
                {
                  run_id: runId,
                  candidates: relation.evidenceOwner.candidates.map(
                    ({
                      pid,
                      identity,
                      applicability,
                      scopeEvidence,
                      relation,
                    }) => ({
                      pid,
                      identity,
                      applicability,
                      scope_evidence: scopeEvidence,
                      relation,
                    }),
                  ),
                },
              ],
        ),
      close,
    };
    return cleanup;
  } catch (cause) {
    return withVerifierCleanup(() => {
      throw cause;
    }, [close]);
  }
}
