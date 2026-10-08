import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Exercise qualified annotation names against real demangled C++ ABI symbols. */
export async function verifyGhidraNamespaceAnnotations({
  call,
  reject,
  target,
  entrypoint,
  env,
}) {
  const exec = promisify(execFile);
  const compiler = process.env.REA_CC ?? "cc";
  try {
    await exec(compiler, ["--version"], { env, timeout: 30000 });
  } catch (cause) {
    throw new Error(
      `Ghidra namespace annotation verification requires a working host C compiler '${compiler}'.`,
      { cause },
    );
  }
  const workspace = await mkdtemp(join(tmpdir(), "rea-ghidra-namespaces-"));
  const source = fileURLToPath(
    new URL("../../tests/conformance/ghidra/namespaces.c", import.meta.url),
  );
  const path = join(workspace, "namespaces");
  try {
    await exec(compiler, ["-O0", "-fno-inline", source, "-o", path], {
      env,
      timeout: 30000,
    });
    const bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await call("close_binary");
    await call("open_binary", { path, provider_id: "ghidra" });
    const procedures = await call("list_procedures");
    const namespaces = ["alpha", "beta", "outer::inner"];
    const entries = namespaces.map((namespace) => {
      const procedure = procedures.find(
        ({ value }) => value === `${namespace}::same`,
      );
      assert.ok(
        procedure,
        `Missing demangled fixture function ${namespace}::same`,
      );
      return { namespace, address: procedure.address };
    });
    const ambiguous = await reject("procedure_address", { procedure: "same" });
    assert.equal(ambiguous.code, "invalid_request");
    for (const { address } of entries)
      assert.ok(JSON.stringify(ambiguous.details.issues).includes(address));
    for (const { namespace, address } of entries) {
      const leaf = await call("annotate_native_function", {
        procedure: address,
        name: "renamed",
        comment: "Preserve this comment",
        inline_comment: "Preserve this inline comment",
      });
      assert.equal(leaf.annotations.name, `${namespace}::renamed`);
      const qualified = await call("annotate_native_function", {
        procedure: address,
        name: `${namespace}::qualified`,
      });
      assert.equal(qualified.annotations.name, `${namespace}::qualified`);
      for (let repeat = 0; repeat < 2; repeat++) {
        const replay = await call("annotate_native_function", {
          procedure: qualified.annotations.name,
          name: qualified.annotations.name,
        });
        assert.deepEqual(replay.annotations, qualified.annotations);
        assert.equal(replay.dossier.procedure.address, address);
      }
      assert.equal(
        await call("procedure_address", {
          procedure: qualified.annotations.name,
        }),
        address,
      );
      for (const name of [
        "other::literal",
        `${namespace}::child::literal`,
        "0xnothex",
        "address%GG:0x1",
        "address:0xnothex",
      ]) {
        const literal = await call("annotate_native_function", {
          procedure: address,
          name,
        });
        const expected = name.startsWith(`${namespace}::`)
          ? name
          : `${namespace}::${name}`;
        assert.equal(literal.annotations.name, expected);
        const repeated = await call("annotate_native_function", {
          procedure: expected,
          name: expected,
        });
        assert.deepEqual(repeated.annotations, literal.annotations);
      }
      await call("annotate_native_function", {
        procedure: address,
        name: qualified.annotations.name,
      });
      const failure = await reject("annotate_native_function", {
        procedure: address,
        name: `${namespace}::`,
        comment: "MUST NOT REPLACE",
        inline_comment: "MUST NOT REPLACE",
      });
      assert.equal(failure.code, "invalid_request");
      assert.deepEqual(failure.details.issues[0].path, ["name"]);
      assert.match(failure.details.issues[0].message, /empty leaf/u);
      const unchanged = await call("annotate_native_function", {
        procedure: address,
        name: qualified.annotations.name,
      });
      assert.deepEqual(unchanged.annotations, qualified.annotations);
    }
    const { stdout } = await exec(
      process.execPath,
      [
        entrypoint,
        "annotate-native-function",
        path,
        "alpha::same",
        "--name",
        "alpha::cli_renamed",
        "--provider",
        "ghidra",
        "--json",
      ],
      { env, timeout: 240000, maxBuffer: 72 * 1024 * 1024 },
    );
    assert.equal(
      JSON.parse(stdout).normalized_result.annotations.name,
      "alpha::cli_renamed",
    );
    assert.equal(
      (await call("analyze_function", { procedure: entries[0].address }))
        .procedure.name,
      "alpha::qualified",
      "The independent CLI session must not alter the active MCP database",
    );
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await call("binary_session")).sha256, sha256);
    await call("close_binary");
    await call("open_binary", { path: target.path, provider_id: "ghidra" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
