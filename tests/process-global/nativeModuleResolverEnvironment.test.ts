import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";

import { NativeModuleResolver } from "../../src/browser/modules/NativeModuleResolver.js";
import { observeProcessStartIdentity } from "../../src/process/ProcessOwnershipObservation.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

afterEach(() => vi.unstubAllEnvs());

// Playwright starts the actual selected executable, which records its environment
// and exits before the browser handshake. This proves launch inheritance only.
it.skipIf(process.platform === "win32")(
  "preserves selected environment values in the real Playwright child",
  async () => {
    const root = await createTestTempDirectory(
      "rea-module-resolver-environment-",
    );
    const command = join(root, "browser");
    const receipt = join(root, "receipt");
    const quotedReceipt = `'${receipt.replaceAll("'", "'\\''")}'`;
    const keys = [
      "REA_MODULE_MISSING",
      "REA_MODULE_UNSET",
      "REA_MODULE_EMPTY",
      "REA_MODULE_SELECTED",
    ];
    const fields = keys.map((key) => `"\${${key}-absent}"`).join(" ");
    await writeFile(
      command,
      `#!/bin/sh\nprintf "%s\\n" "$$" ${fields} > ${quotedReceipt}\nexit 0\n`,
      { mode: 0o755 },
    );

    const environment: Record<string, string | undefined> = {
      REA_BROWSER_EXECUTABLE: command,
      REA_MODULE_UNSET: undefined,
      REA_MODULE_EMPTY: "",
      REA_MODULE_SELECTED: "selected-profile",
    };
    const resolver = new NativeModuleResolver(environment);
    onTestFinished(() => resolver.close());
    for (const key of keys) {
      environment[key] = "later-caller-profile";
      vi.stubEnv(key, "late-ambient-profile");
    }
    const result = await resolver.resolve({
      importerUrl: "https://app.test/main.js",
      importMap: null,
      specifiers: ["./dep.js"],
    });
    expect(result.ok).toBe(false);
    const [rawPid, ...values] = (await readFile(receipt, "utf8")).split("\n");
    expect(values).toEqual(["absent", "absent", "", "selected-profile", ""]);
    const pid = Number(rawPid);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(await observeProcessStartIdentity(pid)).toBeUndefined();
  },
);
