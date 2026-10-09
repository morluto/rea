import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SWIFTC_INTERRUPT } from "../process/DarwinProcessRunTokenReader.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import { safeParseJson } from "../domain/safeJson.js";
import type { NativeUiHelper } from "./NativeUiObservation.js";
import { NATIVE_UI_HELPER_MAX_BUFFER } from "./NativeUiOutputBudget.js";

/** Lazily compile one owned helper per observation/scenario and remove its compiler cache. */
export const createNativeUiHelperRuntime = (
  environment: Readonly<NodeJS.ProcessEnv>,
) => {
  const selectedEnvironment = snapshotEnvironment(environment);
  let root: string | undefined;
  let executable: string | undefined;
  const invoke: NativeUiHelper = async (parameters, signal) => {
    if (executable === undefined) {
      root = await mkdtemp(join(tmpdir(), "rea-native-ui-"));
      const output = join(root, "observer");
      const main = join(root, "main.swift");
      await symlink(
        fileURLToPath(
          new URL("../../bridge/native/ReaNativeUI.swift", import.meta.url),
        ),
        main,
      );
      // Keep swiftc's intermediate objects inside the removable root.
      const compilerTemporary = join(root, "tmp");
      await mkdir(compilerTemporary);
      await execFileOutput(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-module-cache-path",
          join(root, "modules"),
          fileURLToPath(
            new URL(
              "../../bridge/native/NativeUIChildren.swift",
              import.meta.url,
            ),
          ),
          main,
          "-o",
          output,
        ],
        {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          stopSignal: SWIFTC_INTERRUPT,
          env: { ...selectedEnvironment, TMPDIR: compilerTemporary },
          ...(signal === undefined ? {} : { signal }),
        },
      );
      executable = output;
    }
    const output = await execFileOutput(
      executable,
      [JSON.stringify(parameters)],
      {
        timeout: 30_000,
        maxBuffer: NATIVE_UI_HELPER_MAX_BUFFER,
        env: selectedEnvironment,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const parsed = safeParseJson(output.stdout);
    if (!parsed.ok)
      throw new Error(`Native helper returned invalid JSON: ${parsed.error}`, {
        cause: parsed.cause,
      });
    return parsed.value;
  };
  return {
    invoke,
    close: async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    },
  };
};
