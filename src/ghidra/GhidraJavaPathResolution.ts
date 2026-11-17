import { existsSync } from "node:fs";

import { windowsPathCandidates } from "../process/executableSearch.js";

/**
 * Resolve bare `java.exe` against the Windows PATH. The owned-process launcher
 * requires absolute executable paths and does not search PATH, so the
 * documented "JDK on PATH" remediation needs this explicit resolution.
 * The executable search owner parses quoted entries (including embedded `;`)
 * and matches environment names without case; relative entries are skipped so
 * a working-directory java.exe is never selected (the same absolute-directory
 * policy as the darwin java selection).
 */
export const resolveWindowsPathJava = (
  environment: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean = existsSync,
): string | undefined => {
  const search = windowsPathCandidates("java.exe", environment);
  if (!search.ok) return undefined;
  for (const candidate of search.value) {
    if (candidate.relativeEntry) continue;
    if (exists(candidate.path)) return candidate.path;
  }
  return undefined;
};
