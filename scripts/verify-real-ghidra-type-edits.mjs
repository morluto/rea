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

if (process.platform === "win32")
  throw new Error("Ghidra database edits currently support Linux/macOS only.");
const run = createVerifierRun();
// Ghidra children use the root as HOME and TMPDIR; a plain root admits them on every host.
const workspace = await VerifierFixture.open({
  prefix: "rea-ghidra-type-edits-",
  private: false,
});
const root = workspace.path;
const runtime = join(root, "runtime"),
  checkpointDirectory = join(root, "checkpoints");
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const sourcePath = join(root, "fixture.c"),
  target = join(root, "type-edit-fixture");
const env = {
  ...process.env,
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  TMPDIR: runtime,
  JDK_JAVA_OPTIONS: `-Duser.home=${root}`,
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_GHIDRA_CHECKPOINT_DIR: checkpointDirectory,
};
for (const name of [
  "REA_GHIDRA_PROJECT_PATH",
  "REA_GHIDRA_PROGRAM_NAME",
  "REA_GHIDRA_SEED_FILE",
  "REA_GHIDRA_NATIVEAOT_JAR",
  "REA_GHIDRA_LANGUAGE_ID",
  "REA_GHIDRA_COMPILER_SPEC_ID",
  "REA_GHIDRA_DISABLED_ANALYZERS",
])
  delete env[name];
const commands = await createVerifierCommands();
const report = {
  verifier: "ghidra-signature-and-type-edits",
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
    new Client({ name: "rea-ghidra-type-edit-verifier", version: "1" }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  commands.adopt(owner, "type edit MCP connection");
  await owner.open(client, transport);
  const raw = (name, args = {}) =>
    client.callTool({ name, arguments: args }, { timeout: 240000 });
  return {
    call: async (name, args = {}) =>
      requireMcpOperationResult(await raw(name, args), name),
    /** The refusal's single input issue and its recovery. */
    refused: async (name, args, field) => {
      const error = requireMcpToolError(await raw(name, args));
      assert.equal(error.code, "invalid_request");
      assert.deepEqual(
        error.details.issues.map((issue) => issue.path),
        [[field]],
      );
      return {
        message: error.details.issues[0].message,
        action: error.remediation.action,
      };
    },
    close: () => owner.close(),
  };
}

// Without debug information a Mach-O symbol keeps its leading underscore,
// and the function's primary name may be another label at the entry.
const procedure =
  process.platform === "darwin" ? "_rea_session_total" : "rea_session_total";
const sessionType = "/rea_caller_defined/session";
const sessionDeclaration =
  "struct session { int id; char name[32]; unsigned flags; double score; struct session *next; };";
const signature = "double total(const struct session *s, unsigned mask)";
const pseudocode = async (session) =>
  await session.call("procedure_pseudo_code", {
    detail: "complete",
    procedure,
  });
const typeStatus = async (session, type) =>
  (await session.call("inspect_native_data_type", { type })).status;

try {
  await mkdir(runtime);
  await writeFile(
    sourcePath,
    `struct session { int id; char name[32]; unsigned flags; double score; struct session *next; };
__attribute__((noinline)) double rea_session_total(const struct session *s, unsigned mask) {
  double total = 0;
  for (; s; s = s->next) if (s->flags & mask) total += s->score;
  return total;
}
int main(void) { struct session one = { 1, "one", 16, 1.5, 0 }; return (int)rea_session_total(&one, 16); }
`,
  );
  // No debug information: Ghidra must not recover the structure on its own.
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

  let before, baseline;
  const first = await connect();
  try {
    await first.call("open_binary", { path: target, provider_id: "ghidra" });
    await phase("analysis alone recovers no structure fields", async () => {
      before = await pseudocode(first);
      baseline = await first.call("procedure_info", { procedure });
      assert.doesNotMatch(before, /->(?:flags|score|next)/u);
      assert.equal(await typeStatus(first, sessionType), "unavailable");
      return {};
    });
    await phase(
      "a refused signature applies no name, comment or prototype",
      async () => {
        const rejected = {
          procedure,
          name: "rea_must_not_apply",
          comment: "must not apply",
        };
        const undefinedType = await first.refused(
          "annotate_native_function",
          { ...rejected, signature },
          "signature",
        );
        assert.match(undefinedType.message, /does not define: session/u);
        assert.match(undefinedType.action, /define_native_data_types/u);
        const syntax = await first.refused(
          "annotate_native_function",
          { ...rejected, signature: "double total(int a" },
          "signature",
        );
        assert.match(syntax.message, /line 1, column/u);
        const depth = await first.refused(
          "annotate_native_function",
          {
            ...rejected,
            signature: `int total(int a[${"(".repeat(9)}1${")".repeat(9)}])`,
          },
          "signature",
        );
        assert.match(depth.message, /deeper than 8 levels/u);
        for (const refusedSignature of [
          "double total(int a, int a)",
          "double total(int (*callback)(int))",
          "double total(int a[4])",
        ])
          await first.refused(
            "annotate_native_function",
            { ...rejected, signature: refusedSignature },
            "signature",
          );
        assert.equal(await pseudocode(first), before);
        const info = await first.call("procedure_info", { procedure });
        assert.equal(info.name, baseline.name);
        assert.equal(info.signature, baseline.signature);
        assert.equal(info.symbol.source, baseline.symbol.source);
        // The parser's invented placeholder for the undefined tag was not stored.
        assert.equal(await typeStatus(first, sessionType), "unavailable");
        assert.equal(await typeStatus(first, "/session"), "unavailable");
        return {};
      },
    );
    await phase(
      "definitions are stored together, read back and marked caller-defined",
      async () => {
        const defined = await first.call("define_native_data_types", {
          declarations: `${sessionDeclaration}\nenum mode { IDLE, BUSY = 5 }; typedef unsigned long count_t; union value { int i; float f; };`,
        });
        assert.deepEqual(
          defined.types.map(({ id, kind, status }) => [id, kind, status]),
          [
            ["/rea_caller_defined/count_t", "typedef", "defined"],
            ["/rea_caller_defined/mode", "enum", "defined"],
            [sessionType, "struct", "defined"],
            ["/rea_caller_defined/value", "union", "defined"],
          ],
        );
        assert.deepEqual(defined.effects, {
          scope: "session-analysis-database",
          source_bytes_modified: false,
        });
        const layout = await first.call("inspect_native_data_type", {
          type: sessionType,
        });
        assert.equal(layout.source, "caller-defined");
        assert.equal(layout.size_bytes, 56);
        assert.deepEqual(
          layout.fields.map(({ name, offset_bytes }) => [name, offset_bytes]),
          [
            ["id", 0],
            ["name", 4],
            ["flags", 36],
            ["score", 40],
            ["next", 48],
          ],
        );
        assert.equal(
          (await first.call("inspect_native_data_type", { type: "/int" }))
            .source,
          "analysis-database",
        );
        const repeated = await first.call("define_native_data_types", {
          declarations: sessionDeclaration,
        });
        assert.deepEqual(
          repeated.types.map(({ status }) => status),
          ["unchanged"],
        );
        return { types: defined.types.length };
      },
    );
    await phase(
      "a conflicting or unsupported definition stores nothing",
      async () => {
        const conflict = await first.refused(
          "define_native_data_types",
          {
            declarations:
              "struct rea_sibling { int a; }; struct session { long other; };",
          },
          "declarations",
        );
        assert.match(conflict.message, /session/u);
        assert.match(conflict.action, /does not replace/u);
        assert.equal(
          await typeStatus(first, "/rea_caller_defined/rea_sibling"),
          "unavailable",
        );
        const builtin = await first.refused(
          "define_native_data_types",
          { declarations: "struct rea_other { int a; }; typedef long uint;" },
          "declarations",
        );
        assert.match(builtin.message, /uint \(existing \/uint\)/u);
        for (const declarations of [
          "struct rea_user { struct rea_missing *p; };",
          "struct rea_callbacks { int (*fn)(int); };",
          "struct rea_nested { struct { int a; } inner; };",
          "struct rea_broken { int a;",
          "int rea_variable;",
        ])
          await first.refused(
            "define_native_data_types",
            { declarations },
            "declarations",
          );
        for (const name of [
          "rea_other",
          "rea_user",
          "rea_missing",
          "rea_callbacks",
          "rea_nested",
        ])
          assert.equal(
            await typeStatus(first, `/rea_caller_defined/${name}`),
            "unavailable",
          );
        assert.equal(
          (await first.call("inspect_native_data_type", { type: sessionType }))
            .size_bytes,
          56,
        );
        return {};
      },
    );
    await phase(
      "an applied signature is read back and changes the cached decompilation",
      async () => {
        const updated = await first.call("annotate_native_function", {
          procedure,
          comment: "caller-authored prototype",
          signature,
        });
        assert.deepEqual(updated.annotations, {
          address: updated.dossier.procedure.address,
          name: baseline.name,
          comment: "caller-authored prototype",
          inline_comment: null,
          // The prototype's own name, total, is not applied.
          signature: `double ${baseline.name}(session * s, uint mask)`,
          signature_source: "user_defined",
        });
        const after = await pseudocode(first);
        for (const field of ["s->flags", "s->score", "s->next"])
          assert.ok(after.includes(field), `pseudocode must use ${field}`);
        assert.match(updated.dossier.pseudocode, /s->flags/u);
        // Readback is a valid signature edit and changes nothing.
        const replayed = await first.call("annotate_native_function", {
          procedure,
          signature: updated.annotations.signature,
        });
        assert.deepEqual(replayed.annotations, updated.annotations);
        return {};
      },
    );
    await first.call("close_binary");
  } finally {
    await first.close();
  }

  await phase(
    "checkpoint mode restores the types and prototype in a new process",
    async () => {
      const second = await connect();
      try {
        await second.call("open_binary", {
          path: target,
          provider_id: "ghidra",
        });
        const restored = await pseudocode(second);
        for (const field of ["s->flags", "s->score", "s->next"])
          assert.ok(
            restored.includes(field),
            `restored pseudocode must use ${field}`,
          );
        const layout = await second.call("inspect_native_data_type", {
          type: sessionType,
        });
        assert.equal(layout.status, "available");
        assert.equal(layout.source, "caller-defined");
        const repeated = await second.call("define_native_data_types", {
          declarations: sessionDeclaration,
        });
        assert.deepEqual(
          repeated.types.map(({ status }) => status),
          ["unchanged"],
        );
        await second.call("close_binary");
        return {};
      } finally {
        await second.close();
      }
    },
  );
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
