import { createHash } from "node:crypto";
import { writeFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import {
  KunaProjectCache,
  kunaProjectKey,
} from "../../../../src/kuna/KunaProjectCache.js";
import { cleanupOwnedProcessGroup } from "../../../../src/process/ProcessOwnership.js";
import { spawnOwnedProviderProcess } from "../../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { writeFakeKuna, fakeKunaCalls } from "./fakeKuna.js";
import { inspectKunaInstallationOwned } from "./kunaResourceScope.js";
const test = it.skipIf(process.platform === "win32");

test.each([false, true])(
  "keeps exact process ownership through concurrent retries (independent success: %s)",
  async (independentSuccess) => {
    const root = await createTestTempDirectory("rea-kuna-cache-concurrent-");
    const kuna = await writeFakeKuna(root, { project: "hang" });
    const cacheRoot = join(root, "cache");
    const installed = await inspectKunaInstallationOwned({
      REA_KUNA_COMMAND: kuna,
      REA_KUNA_CACHE_DIR: cacheRoot,
    });
    if (!installed.ok) throw new Error(installed.error.reason);
    let retry = false,
      all = false,
      secondProven = false,
      arrived = 0,
      release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = new KunaProjectCache(cacheRoot, {
      maxBytes: 64 * 1024 ** 2,
      launcher: async (options) => {
        const launched = await spawnOwnedProviderProcess(options);
        if (options.arguments[0] !== "decompile-project") return launched;
        const selected = basename(options.arguments[1]!);
        return {
          ...launched,
          cleanup: async () => {
            const cleaned = await cleanupOwnedProcessGroup(launched.ownership);
            if (all) return cleaned;
            if (selected === "second" && secondProven) return cleaned;
            if (retry && selected === "first") {
              arrived++;
              await gate;
              return cleaned;
            }
            return { cleaned: false, reason: `${selected} unproven` };
          },
        };
      },
    });
    const controllers = [new AbortController(), new AbortController()];
    const builds: ReturnType<KunaProjectCache["build"]>[] = [];
    const keys: string[] = [];
    try {
      for (const [index, name] of ["first", "second"].entries()) {
        const targetPath = join(root, name);
        await writeFile(targetPath, name);
        const targetSha256 = createHash("sha256").update(name).digest("hex");
        const key = kunaProjectKey({
          targetSha256,
          targetBasename: name,
          kunaSha256: installed.value.sha256,
          kunaCommand: kuna,
          kunaExecutable: installed.value.executable,
          kunaVersion: installed.value.version,
          jobs: installed.value.configuration.jobs,
        });
        keys.push(key);
        const pending = cache.build({
          installation: installed.value,
          targetPath,
          targetSha256,
          signal: controllers[index]!.signal,
        });
        builds.push(pending);
        await expect
          .poll(async () =>
            (await fakeKunaCalls(kuna)).some(
              ({ argv }) =>
                argv[0] === "decompile-project" && basename(argv[1]!) === name,
            ),
          )
          .toBe(true);
        controllers[index]!.abort();
        await pending;
        expect((await cache.settled(key)).ok).toBe(false);
      }
      const original = await cache.close();
      if (original.ok) throw new Error("Expected two retained cleanup owners");
      expect(await readdir(join(cacheRoot, "staging"))).toHaveLength(2);
      retry = true;
      const first = cache.close();
      const second = cache.close();
      await expect.poll(() => arrived).toBe(1);
      // A different key can still retry while the first owner is held.
      secondProven = independentSuccess;
      expect((await cache.settled(keys[1]!)).ok).toBe(independentSuccess);
      release();
      expect(
        (await Promise.all([first, second])).every(
          (result) => result.ok === independentSuccess,
        ),
      ).toBe(true);
      expect(await readdir(join(cacheRoot, "staging"))).toHaveLength(
        independentSuccess ? 0 : 1,
      );
      expect(original.error.cleanupIncomplete).toBe(!independentSuccess);
      expect(cache.hasPendingCleanup).toBe(!independentSuccess);
      expect((await cache.close()).ok).toBe(independentSuccess);
      all = true;
      expect(await cache.close()).toEqual({ ok: true, value: null });
      expect(original.error.cleanupIncomplete).toBe(false);
      expect(cache.hasPendingCleanup).toBe(false);
      expect(await readdir(join(cacheRoot, "staging"))).toEqual([]);
    } finally {
      controllers.forEach((c) => c.abort());
      release();
      all = true;
      await Promise.all(builds);
      expect(await cache.close()).toEqual({ ok: true, value: null });
    }
  },
);
