import { rm } from "node:fs/promises";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";
import { importVerifierSource } from "./verifier-source-loader.mjs";

/** Keep the workspace and its owned commands together until cleanup completes. */
export async function withVerifierWorkspace(operation, commands, workspace) {
  const { AnalysisCleanupLease } = await importVerifierSource(
    new URL("../../src/artifacts/AnalysisCleanupLease.ts", import.meta.url)
      .href,
    import.meta.url,
  );
  let lease;
  const close = async () => {
    const root = workspace();
    if (root === undefined) return commands.close();
    lease ??= new AnalysisCleanupLease(async () => {
      await commands.close();
      await rm(root, { recursive: true, force: true });
    }, [root]);
    await lease.release();
  };
  try {
    return await withVerifierCleanup(operation, [close]);
  } catch (cause) {
    if (lease !== undefined && !lease.released)
      throw Object.assign(
        new Error(`Verifier workspace cleanup incomplete: ${workspace()}`, {
          cause,
        }),
        { cleanupLeases: [lease] },
      );
    throw cause;
  }
}
