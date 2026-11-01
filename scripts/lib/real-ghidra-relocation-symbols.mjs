import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvidence } from "../../dist/domain/evidence.js";
import { PrivateRuntimeRoot } from "../../dist/process/PrivateRuntimeRoot.js";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";
import { createVerifierCommands } from "./verify-commands.mjs";

const source = fileURLToPath(
  new URL(
    "../../tests/conformance/ghidra/relocation-symbol.c",
    import.meta.url,
  ),
);

/** Verify named and unnamed ELF relocations through the shipped CLI and Ghidra. */
export async function verifyGhidraRelocationSymbols({ clang, lld, env }) {
  const commands = await createVerifierCommands();
  let root;
  let commandsClosed = false;
  return withVerifierCleanup(async () => {
    root = await PrivateRuntimeRoot.create({ prefix: "rea-relocation-proof-" });
    const object = join(root.path, "relocation-symbol.o");
    const target = join(root.path, "relocation-symbol.so");
    const commandEnv = {
      ...env,
      TMPDIR: root.path,
      TMP: root.path,
      TEMP: root.path,
    };
    const run = (command, args) =>
      commands.exec(command, args, {
        env: commandEnv,
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
      });
    await run(clang, [
      "--target=x86_64-linux-gnu",
      "-fPIC",
      "-O0",
      "-c",
      source,
      "-o",
      object,
    ]);
    await run(lld, ["-shared", object, "-o", target]);
    const hash = async () =>
      createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
    const before = await hash();
    const { stdout } = await run(process.execPath, [
      "scripts/rea.mjs",
      "inspect-native-load-image",
      target,
      "--provider",
      "ghidra",
      "--json",
    ]);
    const evidence = parseEvidence(JSON.parse(stdout));
    assert.equal(evidence.subject?.digest.sha256, before);
    assert.equal(evidence.provider.id, "ghidra");
    const report = evidence.normalized_result;
    assert.equal(report.status, "unsupported");
    const relocations = report.observations.relocations;
    assert.ok(
      relocations.some(({ symbol }) => symbol === "rea_external"),
      "The Ghidra relocation must retain its imported symbol",
    );
    assert.ok(
      relocations.some(({ symbol }) => symbol === ""),
      "The provider's empty symbol must remain distinct from an unrecorded field",
    );
    assert.equal(await hash(), before);
    return {
      source,
      target_sha256: before,
      named_symbol: "rea_external",
      empty_symbol: true,
    };
  }, [
    async () => {
      await commands.close();
      commandsClosed = true;
    },
    async () => {
      if (commandsClosed && root !== undefined) await root.close();
    },
  ]);
}
