import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import type { AnalysisProvider } from "../AnalysisProvider.js";
import { BinarySession } from "./BinarySession.js";
import { toolSessionEffects } from "../../contracts/toolEffects.js";
import { ok } from "../../domain/result.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestProviderRouter,
} from "../../../tests/fixtures/binarySession.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

it.each([
  ["open_binary", false],
  ["open_binary", true],
  ["open_bundle_resources", false],
  ["open_bundle_resources", true],
] as const)(
  "%s advertises prior-client retirement with simulated checkpoint=%s",
  async (operation, checkpoint) => {
    const [first, second] = await createBinarySessionTargets();
    const root = await createTestTempDirectory("rea-open-effects-");
    const bundle = join(root, "Resources.app");
    await mkdir(bundle);
    await writeFile(join(bundle, "Info.plist"), "<plist><dict/></plist>");
    const checkpointPath = join(root, "configured-checkpoint.json");
    const editsByClient: string[][] = [];
    let retiredEdits: string[] | undefined;
    const provider: AnalysisProvider = {
      ...createCacheProvider([]),
      createClient: () => {
        const edits: string[] = [];
        editsByClient.push(edits);
        return {
          execute: async (name) => {
            if (name === "set_address_name") edits.push("analyst-name");
            return observed(null);
          },
          close: async () => {
            if (edits.length > 0) {
              retiredEdits = [...edits];
              // Simulate the supported close contract, without running Ghidra.
              if (checkpoint)
                await writeFile(checkpointPath, JSON.stringify(edits));
              edits.length = 0;
            }
            return ok(null);
          },
        };
      },
    };
    const session = new BinarySession(
      createTestProviderRouter(provider),
      undefined,
      {
        createClient: () => ({
          client: {
            execute: async () => observed(null),
            close: async () => ok(null),
          },
          capabilities: [],
        }),
      },
    );
    onTestFinished(async () => {
      expect((await session.close()).ok).toBe(true);
    });
    expect((await session.open(first)).ok).toBe(true);
    expect(
      (
        await session.execute("set_address_name", {
          address: "0x1000",
          name: "analyst-name",
        })
      ).ok,
    ).toBe(true);
    expect(editsByClient[0]).toEqual(["analyst-name"]);
    const replaced =
      operation === "open_binary"
        ? await session.open(second)
        : await session.openBundleResources(bundle);
    expect(replaced.ok).toBe(true);
    expect(retiredEdits).toEqual(["analyst-name"]);
    expect(editsByClient[0]).toEqual([]);
    if (checkpoint)
      expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toEqual([
        "analyst-name",
      ]);
    else
      await expect(readFile(checkpointPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(toolSessionEffects(operation)).toMatchObject({
      writesFilesystem: true,
      mayDiscardData: true,
    });
  },
);
