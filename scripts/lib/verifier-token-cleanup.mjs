import { verifyNoTokenOwnedProcesses } from "../../dist/process/ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "../../dist/process/ProcessOwnershipEvidence.js";
import { createSystemProcessOwnershipHost } from "../../dist/process/ProcessOwnershipObservation.js";

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
    const relation = {
      leaderPid: run.verifier_pid,
      processGroupId: launcher.processGroupId,
      evidenceOwner: new ProcessOwnershipEvidenceOwner(),
    };
    return {
      verify: () =>
        verifyNoTokenOwnedProcesses(run.run_id, host, baseline, relation),
      close: async () => {
        await host.close?.();
      },
    };
  } catch (cause) {
    await host.close?.();
    throw cause;
  }
}
