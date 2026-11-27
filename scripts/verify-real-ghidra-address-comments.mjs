#!/usr/bin/env node
import { sha256File } from "./lib/verifier-file-sha256.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { createVerifierMcpOwner } from "./lib/verifier-mcp-owner.mjs";

import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  requireMcpOperationResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import {
  createVerifierRun,
  completeVerifierRun,
  assertVerifierCleanupComplete,
} from "./lib/verifier-run.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";
import { completeEvidenceClient } from "./lib/complete-evidence.mjs";

// Regular and inline comments at arbitrary mapped addresses in a real Ghidra
// session: inside a function body and at data, read back, cleared, refused for
// unmapped addresses and unrepresentable text, kept apart from the function's
// entry comments, and discarded on close. The fixture is never executed.
if (process.platform === "win32")
  throw new Error("Ghidra database edits currently support Linux/macOS only.");
const run = createVerifierRun();
// Ghidra children use the root as HOME and TMPDIR; a plain root admits them on every host.
const workspace = await VerifierFixture.open({
  prefix: "rea-ghidra-address-comments-",
  private: false,
});
const root = workspace.path;
const runtime = join(root, "runtime");
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const sourcePath = join(root, "fixture.c"),
  target = join(root, "comment-fixture");
const env = {
  ...process.env,
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  TMPDIR: runtime,
  JDK_JAVA_OPTIONS: `-Duser.home=${root}`,
  REA_ANALYSIS_PROVIDER: "ghidra",
};
for (const name of [
  "REA_GHIDRA_PROJECT_PATH",
  "REA_GHIDRA_PROGRAM_NAME",
  "REA_GHIDRA_SEED_FILE",
  "REA_GHIDRA_CHECKPOINT_DIR",
  "REA_GHIDRA_LANGUAGE_ID",
  "REA_GHIDRA_COMPILER_SPEC_ID",
  "REA_GHIDRA_DISABLED_ANALYZERS",
])
  delete env[name];
const commands = await createVerifierCommands();
const report = {
  verifier: "ghidra-address-comments",
  phases: [],
  target: null,
};

async function phase(name, operation) {
  const start = performance.now();
  try {
    const facts = await operation();
    report.phases.push({
      name,
      status: "verified",
      elapsed_ms: Math.round(performance.now() - start),
      ...facts,
    });
  } catch (cause) {
    report.phases.push({
      name,
      status: "failed",
      elapsed_ms: Math.round(performance.now() - start),
    });
    throw cause;
  }
}

async function connect() {
  const owner = createVerifierMcpOwner();
  const client = completeEvidenceClient(
    new Client({ name: "rea-ghidra-address-comment-verifier", version: "1" }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  commands.adopt(owner, "address comment MCP connection");
  await owner.open(client, transport);
  const raw = (name, args = {}) =>
    client.callTool({ name, arguments: args }, { timeout: 240000 });
  return {
    raw,
    call: async (name, args = {}) =>
      requireMcpOperationResult(await raw(name, args), name),
    /** The typed refusal of a request, before any change, and the bridge's reason. */
    refused: async (name, args) => {
      const error = requireMcpToolError(await raw(name, args));
      assert.equal(error.code, "invalid_request", JSON.stringify(error));
      assert.equal(error.details.issues.length, 1, JSON.stringify(error));
      return error.details.issues[0].message;
    },
    close: () => owner.close(),
  };
}

// Without debug information a Mach-O symbol keeps its leading underscore.
const symbol = (name) => (process.platform === "darwin" ? `_${name}` : name);
const procedure = symbol("rea_comment_total");
const table = symbol("rea_comment_table");
// Far above any address this small fixture maps.
const unmapped = "0x7ffffff00000";

try {
  await mkdir(runtime);
  await writeFile(
    sourcePath,
    `int rea_comment_table[4] = { 3, 5, 7, 11 };
__attribute__((noinline)) int rea_comment_total(int count) {
  int total = 0;
  for (int index = 0; index < count && index < 4; index++) total += rea_comment_table[index];
  return total * 3 + 1;
}
int main(void) { return rea_comment_total(4); }
`,
  );
  // The macOS target is the object so the fixture needs no SDK link step.
  await commands.exec(
    "cc",
    [
      "-O1",
      "-g0",
      "-fno-inline",
      ...(process.platform === "darwin" ? ["-c"] : []),
      sourcePath,
      "-o",
      target,
    ],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const targetDigest = await sha256File(target);
  report.target = {
    sha256: targetDigest,
    source: `self-built C fixture without debug information (${process.platform === "darwin" ? "object" : "executable"}); never executed`,
    host: process.platform,
    architecture: process.arch,
  };

  let entry, interior, data;
  const first = await connect();
  try {
    await first.call("open_binary", { path: target, provider_id: "ghidra" });
    await phase(
      "locate an interior instruction and a data address",
      async () => {
        const instructions = await first.call("read_function_instructions", {
          procedure,
        });
        // Each instruction line starts with its canonical address.
        const listed = instructions.instructions.map(
          (line) => line.split(":")[0],
        );
        assert.ok(listed.length > 2, JSON.stringify(instructions));
        entry = instructions.procedure.address;
        assert.equal(listed[0], entry);
        interior = listed[2];
        // list_names reports each symbol as an address/value pair.
        const names = await first.call("list_names", { detail: "complete" });
        data = names.find(({ value }) => value === table)?.address;
        assert.ok(typeof data === "string", `no address for ${table}`);
        return { entry, interior, data };
      },
    );

    await phase(
      "comments write and read back inside a function and at data",
      async () => {
        await first.call("annotate_native_function", {
          procedure: entry,
          comment: "entry note",
          inline_comment: "entry inline",
        });
        const text = "Evidence ev_1: café 🔍\r\nsecond line";
        assert.equal(
          await first.call("set_comment", { address: interior, comment: text }),
          true,
        );
        assert.equal(await first.call("comment", { address: interior }), text);
        assert.equal(
          await first.call("inline_comment", { address: interior }),
          null,
        );
        assert.equal(
          await first.call("set_inline_comment", {
            address: data,
            comment: "lookup table: 4 primes",
          }),
          true,
        );
        assert.equal(
          await first.call("inline_comment", { address: data }),
          "lookup table: 4 primes",
        );
        assert.equal(await first.call("comment", { address: data }), null);
        // Arbitrary-address writes leave the function's entry comments alone.
        assert.equal(
          await first.call("comment", { address: entry }),
          "entry note",
        );
        assert.equal(
          await first.call("inline_comment", { address: entry }),
          "entry inline",
        );
        const dossier = await first.call("analyze_function", {
          procedure,
          detail: "complete",
        });
        assert.ok(
          dossier.comments.some(
            (item) =>
              item.address === interior &&
              item.kind === "comment" &&
              item.text === text,
          ),
          JSON.stringify(dossier.comments),
        );
        return {};
      },
    );

    await phase(
      "refused writes change nothing and an empty comment clears",
      async () => {
        assert.match(
          await first.refused("set_comment", {
            address: unmapped,
            comment: "must not write",
          }),
          /not mapped/u,
        );
        assert.match(
          await first.refused("set_comment", {
            address: interior,
            comment: "nul\u0000text",
          }),
          /NUL/u,
        );
        assert.match(
          await first.refused("set_inline_comment", {
            address: data,
            comment: "half \ud800 pair",
          }),
          /surrogate/u,
        );
        assert.match(
          await first.refused("comment", { address: unmapped }),
          /not mapped/u,
        );
        assert.equal(
          await first.call("comment", { address: interior }),
          "Evidence ev_1: café 🔍\r\nsecond line",
        );
        assert.equal(
          await first.call("inline_comment", { address: data }),
          "lookup table: 4 primes",
        );
        assert.equal(
          await first.call("set_comment", { address: interior, comment: "" }),
          true,
        );
        assert.equal(await first.call("comment", { address: interior }), null);
        return {};
      },
    );
    await first.call("close_binary");
  } finally {
    await first.close();
  }

  await phase("edits are discarded when the session closes", async () => {
    const second = await connect();
    try {
      await second.call("open_binary", { path: target, provider_id: "ghidra" });
      assert.equal(
        await second.call("inline_comment", { address: data }),
        null,
      );
      assert.equal(await second.call("comment", { address: entry }), null);
      await second.call("close_binary");
    } finally {
      await second.close();
    }
    return {};
  });

  assert.equal(await sha256File(target), targetDigest);
  assert.deepEqual(await readdir(runtime), []);
  report.status = "verified";
} catch (cause) {
  report.status = "failed";
  report.error = cause instanceof Error ? cause.stack : String(cause);
  process.exitCode = 1;
} finally {
  let cleanupVerified = false;
  try {
    await workspace.closeEarly([() => commands.close()]);
    report.run = await completeVerifierRun(run);
    assertVerifierCleanupComplete(report.run.process_lineage);
    cleanupVerified = true;
  } catch (cause) {
    report.cleanup_error = String(cause);
    report.retained_workspace = root;
    process.exitCode = 1;
  }
  if (cleanupVerified && report.status === "verified") {
    try {
      await workspace.release();
    } catch (cause) {
      report.cleanup_error = String(cause);
      report.retained_workspace = root;
      process.exitCode = 1;
    }
  } else if (report.retained_workspace === undefined) {
    report.retained_workspace = root;
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
