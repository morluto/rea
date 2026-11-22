import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  javaScriptRuntime,
  type JavaScriptRuntime,
} from "../domain/runtimeVersion.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

/** Runtime-specific absolute argv script selection, or undefined when none was supplied.
 * Native executable paths have different traversal semantics and must not use this.
 */
export const normalizeEntrypointPath = (
  entrypoint: string | undefined,
  runtime: JavaScriptRuntime["id"] = javaScriptRuntime(process.versions).id,
): string | undefined =>
  entrypoint === undefined || entrypoint.length === 0
    ? undefined
    : runtime === "bun"
      ? absoluteCallerPath(entrypoint)
      : resolve(entrypoint);

export const CURRENT_ENTRYPOINT_PATH = normalizeEntrypointPath(process.argv[1]);

/** True when the runtime executed `moduleUrl` directly rather than importing it.
 * A synthetic argv path that no longer resolves is not a direct run.
 */
export const isDirectEntrypoint = (
  entryPath: string | undefined,
  moduleUrl: string,
): boolean => {
  if (entryPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entryPath)).href === moduleUrl;
  } catch {
    return false;
  }
};
