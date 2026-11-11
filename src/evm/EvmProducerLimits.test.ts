import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
import { selectedEvmProducerLimits } from "../domain/evm/evmInterface.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const require = createRequire(import.meta.url);

it("recovers complete EVMole worker evidence for the same carrier after raising reply admission", async () => {
  const root = await createTestTempDirectory("rea-evm-producer-limits-");
  const snapshot = join(root, "carrier.snapshot");
  await writeFile(snapshot, "0x60006000f3\n");
  const inspect = async (outputBytes: number, index: number) => {
    const requestPath = join(root, `request-${index}.json`);
    const reply = join(root, `reply-${index}.json`);
    await writeFile(
      requestPath,
      JSON.stringify({
        snapshot_path: snapshot,
        reply_path: reply,
        failure_marker_path: join(root, `failure-${index}`),
        encoding: "hex",
        producer_limits: selectedEvmProducerLimits({
          output_bytes: outputBytes,
        }),
      }),
    );
    await runOwnedCommand(
      {
        command: process.execPath,
        arguments: [
          "--import",
          require.resolve("tsx"),
          "--max-old-space-size=256",
          "--disable-wasm-trap-handler",
          fileURLToPath(new URL("./EvmoleInterfaceWorker.ts", import.meta.url)),
          requestPath,
        ],
        cwd: root,
        runId: `evm-producer-limits-${index}`,
      },
      { timeoutMs: 10000, diagnosticBytes: 1024 * 1024 },
    );
    return JSON.parse(await readFile(reply, "utf8"));
  };
  const refused = await inspect(256, 0);
  expect(refused).toMatchObject({ ok: false, reason: "output-limit" });
  const recovered = await inspect(4096, 1);
  expect(recovered).toMatchObject({
    ok: true,
    version: "0.9.3",
    bytecode: {
      bytes: 5,
      hex: "60006000f3",
    },
  });
  // A larger resource budget does not change the explicitly selected encoding contract.
  await writeFile(snapshot, "0xzz");
  expect(await inspect(4096, 2)).toMatchObject({ ok: false, reason: "format" });
});
