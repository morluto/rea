import { mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import {
  hashXpandaEngine,
  XpandaEngineScanError,
} from "./XpandaEngineIdentity.js";

const checkout = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-xpanda-engine-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"xpanda"}');
  await writeFile(join(root, "src", "index.ts"), "export const x = 1;\n");
  return root;
};

const failure = async (root: string): Promise<XpandaEngineScanError> =>
  hashXpandaEngine(root).then(
    () => {
      throw new Error("expected the engine scan to refuse the checkout");
    },
    (cause: unknown) => {
      if (!(cause instanceof XpandaEngineScanError)) throw cause;
      return cause;
    },
  );

describe("xpanda engine identity", () => {
  it("digests a plain checkout", async () => {
    const identity = await hashXpandaEngine(await checkout());
    expect(identity.files).toBe(2);
    expect(identity.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("includes 3.x workspace manifests and sources", async () => {
    const root = await checkout();
    await mkdir(join(root, "packages", "xpanda-mcp", "src"), {
      recursive: true,
    });
    await writeFile(
      join(root, "packages", "xpanda-mcp", "package.json"),
      '{"name":"@x/mcp"}',
    );
    await writeFile(
      join(root, "packages", "xpanda-mcp", "src", "server.ts"),
      "// entry\n",
    );
    const identity = await hashXpandaEngine(root);
    expect(identity.files).toBe(4);
  });

  it.skipIf(process.platform === "win32")(
    "refuses linked source it cannot cover",
    async () => {
      const root = await checkout();
      await symlink(
        join(root, "src", "index.ts"),
        join(root, "src", "link.ts"),
      );
      expect(await failure(root)).toMatchObject({ code: "linked_code" });
    },
  );

  it("refuses a file whose declared size exceeds the scan bound", async () => {
    const root = await checkout();
    await truncate(join(root, "src", "index.ts"), 70 * 1024 * 1024);
    expect(await failure(root)).toMatchObject({ code: "too_many_bytes" });
  });
});
