import type { BinarySession } from "../application/BinarySession.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { projectAnalysisError } from "../domain/errors.js";

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
  await session.close();
  serverLogger.error(
    { errorTag: opened.error._tag },
    "Initial target failed to open",
  );
  writeStderr(`${projectAnalysisError(opened.error).message}\n`);
  return { ok: false, exitCode: 1 };
};
