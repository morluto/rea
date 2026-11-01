import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEvidence } from "../../dist/domain/evidence.js";

const exec = promisify(execFile);
const source = fileURLToPath(
  new URL(
    "../../tests/conformance/ghidra/relocation-symbol.c",
    import.meta.url,
  ),
);

/** Verify named and unnamed ELF relocations through the shipped CLI and Ghidra. */
export async function verifyGhidraRelocationSymbols({
  clang,
  lld,
  workspace,
  env,
}) {
  const object = join(workspace, "relocation-symbol.o");
  const target = join(workspace, "relocation-symbol.so");
  await exec(
    clang,
    ["--target=x86_64-linux-gnu", "-fPIC", "-O0", "-c", source, "-o", object],
    { env },
  );
  await exec(lld, ["-shared", object, "-o", target], { env });
  const hash = async () =>
    createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
  const before = await hash();
  const { stdout } = await exec(
    process.execPath,
    [
      "scripts/rea.mjs",
      "inspect-native-load-image",
      target,
      "--provider",
      "ghidra",
      "--json",
    ],
    { env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
  );
  const evidence = parseEvidence(JSON.parse(stdout));
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
}
