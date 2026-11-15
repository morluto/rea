import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Resolve bare `java.exe` against Path/PATH on Windows. The owned-process
 * launcher requires absolute executable paths and does not search PATH, so
 * the documented "JDK on PATH" remediation needs this explicit resolution.
 * Quoted entries are unwrapped; empty and relative entries are skipped so a
 * working-directory java.exe is never selected (the same absolute-directory
 * policy as the darwin java selection).
 */
export const resolveWindowsPathJava = (
  environment: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean = existsSync,
): string | undefined => {
  const pathVariable = environment.Path ?? environment.PATH ?? "";
  for (const directory of pathVariable.split(";")) {
    const trimmed = directory.trim().replace(/^"|"$/gu, "");
    if (trimmed === "" || !isAbsolute(trimmed)) continue;
    const candidate = join(trimmed, "java.exe");
    if (exists(candidate)) return candidate;
  }
  return undefined;
};
