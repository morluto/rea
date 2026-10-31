import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const closeState = vi.hoisted(() => ({
  path: "",
  failures: 0,
  attempts: 0,
  release: [] as Array<() => Promise<void>>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] !== closeState.path) return handle;
      const close = handle.close.bind(handle);
      closeState.release.push(close);
      handle.close = async () => {
        closeState.attempts++;
        if (closeState.failures > 0) {
          closeState.failures--;
          throw Object.assign(new Error("injected descriptor close failure"), {
            code: "EIO",
          });
        }
        await close();
      };
      return handle;
    },
  };
});

import { createCli } from "../../src/cli.js";
import { CLI_COMMANDS } from "../../src/cliCommandNames.js";
import { BYTE_ENTROPY_PROVIDER } from "../../src/domain/investigationProviders.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const exitCode = process.exitCode;
afterEach(async () => {
  closeState.path = "";
  closeState.failures = 0;
  closeState.attempts = 0;
  process.exitCode = exitCode;
  // Injected failures leave the real descriptor open; release it before the
  // fixture directory is removed.
  await Promise.all(closeState.release.splice(0).map((close) => close()));
});

const inspect = async (path: string): Promise<unknown> => {
  let stdout = "";
  await createCli({}).serve(
    [CLI_COMMANDS.inspectByteEntropy, path, "--format", "json"],
    {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => undefined,
    },
  );
  return JSON.parse(stdout);
};

it.each([
  { closeFails: true, attempts: 2 },
  { closeFails: false, attempts: 1 },
])(
  "names the Evidence provider in cleanup diagnostics (close fails: $closeFails)",
  async ({ closeFails, attempts }) => {
    const directory = await createTestTempDirectory("rea-entropy-cleanup-cli-");
    const path = join(directory, "entropy-input.bin");
    const content = Buffer.from("entropy fixture\n".repeat(32));
    await writeFile(path, content);
    closeState.path = path;
    closeState.failures = closeFails ? Number.MAX_SAFE_INTEGER : 0;

    const output = await inspect(path);

    expect(closeState.attempts).toBe(attempts);
    if (!closeFails) {
      expect(output).toMatchObject({
        provider: { id: BYTE_ENTROPY_PROVIDER.id },
      });
      expect(output).not.toHaveProperty("code");
      return;
    }
    expect(output).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        cleanup: "incomplete",
        diagnostics: {
          primary_error: {
            details: {
              partial_observation: {
                provider: { id: BYTE_ENTROPY_PROVIDER.id },
                subject: {
                  digest: {
                    sha256: createHash("sha256").update(content).digest("hex"),
                  },
                },
                normalized_result: { artifact: { bytes: content.length } },
              },
            },
          },
          cleanup_error: {
            code: "cleanup_incomplete",
            details: { provider_id: BYTE_ENTROPY_PROVIDER.id },
          },
        },
      },
    });
    expect(process.exitCode).toBe(1);
  },
);
