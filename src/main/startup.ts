import type { BinarySession } from "../application/binary/BinarySession.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

export const openInitialTarget = async (
  session: BinarySession,
  config: AppConfig,
  serverLogger: Logger,
  writeStderr: (text: string) => void,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly exitCode: 1 }
> => {
  if (config.hopperTargetPath === undefined) return { ok: true };
  const opened = await session.open(config.hopperTargetPath, {
    targetKind: config.hopperTargetKind,
  });
  if (opened.ok) return { ok: true };
  const closed = await session.close();
  serverLogger.error(
    {
      error: projectAnalysisError(opened.error),
      ...(closed.ok
        ? {}
        : { cleanup_error: projectAnalysisError(closed.error) }),
    },
    "Initial target failed to open",
  );
  writeStderr(`${projectAnalysisError(opened.error).message}\n`);
  if (!closed.ok)
    writeStderr(`${projectAnalysisError(closed.error).message}\n`);
  return { ok: false, exitCode: 1 };
};
