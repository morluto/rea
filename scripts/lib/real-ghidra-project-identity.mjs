import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { requireMcpToolError } from "./mcp-verifier-results.mjs";

const exec = promisify(execFile);

/** Verify selected-project identity refusal through real CLI and MCP adapters. */
export async function verifyGhidraProjectIdentity({ target, entrypoint, env }) {
  if (process.platform === "win32")
    return {
      status: "not-applicable",
      reason: "Existing Ghidra projects are not admitted on Windows.",
    };
  assert.ok(env.GHIDRA_INSTALL_DIR, "Ghidra installation is required");
  const root = await mkdtemp(join(env.TMPDIR, "rea-project-identity-"));
  const targetPath = target.path;
  const different = join(root, "different-target");
  const headless = join(env.GHIDRA_INSTALL_DIR, "support", "analyzeHeadless");
  const fixtureEnv = {
    ...env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    JDK_JAVA_OPTIONS: `-Duser.home="${root}"`,
  };
  const program = basename(targetPath);
  const known = join(root, "known.gpr");
  const unknown = join(root, "unknown.gpr");
  const runtimeRootsBefore = (await readdir(env.TMPDIR))
    .filter((name) => name.startsWith("rea-ghidra-"))
    .sort();
  const sha = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  try {
    await copyFile(targetPath, different);
    await appendFile(different, "\nREA_IDENTITY_VERIFIER\n");
    assert.notEqual(await sha(different), await sha(targetPath));
    await writeFile(
      join(root, "ClearImportDigest.java"),
      `import ghidra.app.script.GhidraScript;
public class ClearImportDigest extends GhidraScript {
  @Override public void run() {
    currentProgram.setExecutableSHA256(null);
    println("REA_DIGEST_AFTER=" + currentProgram.getExecutableSHA256());
  }
}\n`,
    );
    await exec(
      headless,
      [root, "known", "-import", targetPath, "-noanalysis"],
      { env: fixtureEnv, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
    );
    const cleared = await exec(
      headless,
      [
        root,
        "unknown",
        "-import",
        targetPath,
        "-noanalysis",
        "-scriptPath",
        root,
        "-postScript",
        "ClearImportDigest.java",
      ],
      { env: fixtureEnv, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.match(cleared.stdout, /REA_DIGEST_AFTER=unknown/u);
    const before = await projectState([known, unknown, targetPath, different]);

    const knownEnv = {
      ...env,
      REA_GHIDRA_PROJECT_PATH: known,
      REA_GHIDRA_PROGRAM_NAME: program,
    };
    const unknownEnv = {
      ...env,
      REA_GHIDRA_PROJECT_PATH: unknown,
      REA_GHIDRA_PROGRAM_NAME: program,
    };
    const mismatch = await selectedProjectMcp({
      entrypoint,
      env: knownEnv,
      first: different,
      matching: targetPath,
      expected: "import_identity_mismatch",
    });
    const unavailable = await selectedProjectMcp({
      entrypoint,
      env: unknownEnv,
      first: targetPath,
      expected: "import_identity_unavailable",
    });
    for (const [label, selectedEnv, input, expected] of [
      ["mismatch", knownEnv, different, "import_identity_mismatch"],
      ["unavailable", unknownEnv, targetPath, "import_identity_unavailable"],
    ]) {
      let failed;
      try {
        await exec(
          process.execPath,
          [
            entrypoint,
            "decompile",
            input,
            "0x0",
            "--provider",
            "ghidra",
            "--format",
            "json",
          ],
          { env: selectedEnv, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
        );
      } catch (cause) {
        assert.equal(cause.code, 1, `${label} CLI exit`);
        failed = JSON.parse(cause.stdout);
      }
      assert.ok(failed, `${label} CLI must refuse`);
      assert.equal(failed.code, "configuration_invalid");
      assert.equal(failed.details.diagnostics.remote_code, expected);
    }
    assert.deepEqual(
      await projectState([known, unknown, targetPath, different]),
      before,
    );
    assert.deepEqual(
      (await readdir(env.TMPDIR))
        .filter((name) => name.startsWith("rea-ghidra-"))
        .sort(),
      runtimeRootsBefore,
      "Selected-project checks left a Ghidra runtime directory",
    );
    return {
      status: "verified",
      mismatch,
      unavailable,
      cli_refusals: true,
      source_files_unchanged: true,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function selectedProjectMcp({
  entrypoint,
  env,
  first,
  matching,
  expected,
}) {
  const client = new Client({
    name: "rea-project-identity-verifier",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = new Map(
      (await client.listTools()).tools.map((tool) => [tool.name, tool]),
    );
    const call = (name, arguments_) =>
      client.callTool(
        { name, arguments: arguments_ },
        { timeout: 180000, toolDefinition: tools.get(name) },
      );
    assert.notEqual(
      (await call("open_binary", { path: first, provider_id: "ghidra" }))
        .isError,
      true,
    );
    const rejected = requireMcpToolError(await call("list_documents", {}));
    assert.equal(
      rejected.code,
      "configuration_invalid",
      JSON.stringify({
        code: rejected.code,
        message: rejected.message,
        failure_kind: rejected.details?.diagnostics?.failure_kind,
        failure_message: rejected.details?.diagnostics?.failure_message,
        stdout: rejected.details?.diagnostics?.stdout?.text?.slice(-2500),
        stderr: rejected.details?.diagnostics?.stderr?.text?.slice(-1000),
      }),
    );
    assert.equal(rejected.details.diagnostics.remote_code, expected);
    if (matching !== undefined) {
      assert.notEqual(
        (await call("open_binary", { path: matching, provider_id: "ghidra" }))
          .isError,
        true,
      );
      assert.notEqual((await call("list_documents", {})).isError, true);
    }
    assert.notEqual((await call("close_binary", {})).isError, true);
    return {
      refused: expected,
      matching_target_reopened: matching !== undefined,
    };
  } finally {
    await client.close();
    await transport.close();
  }
}

async function projectState(paths) {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const path of paths) {
    files.push(path);
    if (path.endsWith(".gpr")) await walk(`${path.slice(0, -4)}.rep`);
  }
  files.sort();
  return Promise.all(
    files.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ]),
  );
}
