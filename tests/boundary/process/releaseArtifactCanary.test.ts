import {
  copyFile,
  cp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";
import { resolveSwiftcCompileTimeoutMs } from "../../../src/process/DarwinProcessRunTokenReader.js";

const preparationBudget =
  process.platform === "darwin" ? resolveSwiftcCompileTimeoutMs() : 0;

async function prepareController(controller: string, version: string) {
  // The verifier loads its production-owned TypeScript source graph at runtime.
  // Keep that graph in the isolated controller so imports cannot drift from a hand-maintained list.
  await mkdir(join(controller, "scripts"), { recursive: true });
  await copyFile(
    "scripts/verify-release-artifact.mjs",
    join(controller, "scripts/verify-release-artifact.mjs"),
  );
  await cp("scripts/lib", join(controller, "scripts/lib"), {
    recursive: true,
  });
  await mkdir(join(controller, "bridge"), { recursive: true });
  await cp("bridge/process", join(controller, "bridge/process"), {
    recursive: true,
  });
  await cp("src", join(controller, "src"), {
    recursive: true,
    filter: (source) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(source),
  });
  await writeFile(
    join(controller, "package.json"),
    JSON.stringify({ name: "rea-agents", version, type: "module" }),
  );
  await symlink(
    resolve("node_modules"),
    join(controller, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function snapshotCatalog() {
  const harness = await createApplicationMcpHarness();
  try {
    const tools = await harness.client.listTools();
    const sessionDefinition = tools.tools.find(
      ({ name }) => name === "binary_session",
    );
    if (sessionDefinition === undefined)
      throw new Error("Canary snapshot omitted binary_session");
    return {
      serverInfo: harness.client.getServerVersion(),
      protocolVersion: harness.client.getNegotiatedProtocolVersion(),
      tools,
      reply: await harness.client.callTool(
        { name: "binary_session", arguments: {} },
        { toolDefinition: sessionDefinition },
      ),
    };
  } finally {
    await harness.close();
  }
}

async function prepareCandidate(
  candidate: string,
  version: string,
  snapshot: unknown,
) {
  await mkdir(join(candidate, "scripts"), { recursive: true });
  await writeFile(
    join(candidate, "package.json"),
    JSON.stringify({
      name: "rea-agents",
      version,
      type: "module",
      files: ["scripts"],
    }),
  );
  await copyFile(
    "tests/fixtures/mcpDoctorReply.mjs",
    join(candidate, "scripts/replay.mjs"),
  );
  await writeFile(
    join(candidate, "scripts/reply.json"),
    JSON.stringify(snapshot),
  );
  await writeFile(
    join(candidate, "scripts/rea.mjs"),
    `
import { fileURLToPath } from "node:url";
if (process.argv[2] === "mcp") {
process.argv[2] = fileURLToPath(new URL("./reply.json", import.meta.url));
await import("./replay.mjs");
} else if (["--help", "--llms"].includes(process.argv[2])) {
console.log("REA fixture CLI");
} else { process.exitCode = 1; }
`,
  );
}

/** Verify the controller/checker process contract without requiring engine installs in each test shard. */
async function installCheckerFixture(controller: string) {
  await writeFile(
    join(controller, "scripts/verify-advertised-schemas.mjs"),
    `
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const [selected, ...options] = process.argv.slice(2);
assert.ok(selected?.startsWith("--package-root="));
assert.deepEqual(options, ["--complete"]);
assert.equal(process.env.REA_REQUIRE_SCHEMA_ENGINES, "1");
assert.equal(process.env.REA_SCHEMA_ENGINES_PYTHON, "fixture-engine-python");
const installed = selected.slice("--package-root=".length);
assert.equal(resolve(installed, "../../.."), process.cwd());
// Only the installed candidate contains the reply; the controller does not.
await readFile(join(installed, "scripts/reply.json"));
try {
  await access(join(installed, "scripts/refuse-schemas"));
  console.error("fixture client validator refused the installed catalog");
  process.exitCode = 1;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  console.log("fixture client validator accepted the installed catalog");
}
`,
  );
}

// Release rehearsal runs on Linux; the npm process adapter is also exercised on macOS.
processTest.skipIf(process.platform === "win32")(
  "fails without declared runtime, then rehearses an installed tarball and rejects catalog drift",
  { timeout: Math.min(2_147_483_647, 3 * preparationBudget + 210_000) },
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-release-canary-");
    const candidate = join(root, "candidate");
    const controller = join(root, "controller");
    const { version } = z
      .object({ version: z.string() })
      .parse(JSON.parse(await readFile("package.json", "utf8")));
    const snapshot = await snapshotCatalog();
    await prepareCandidate(candidate, version, snapshot);
    const pack = async () => {
      const result = await processes.run(
        "npm",
        ["pack", "--ignore-scripts", "--json"],
        { cwd: candidate },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      return result;
    };
    const packed = await pack();
    const [{ filename }] = z
      .tuple([z.object({ filename: z.string() })])
      .parse(JSON.parse(packed.stdout));
    const tarball = join(candidate, filename);
    await prepareController(controller, version);
    const invoke = (selected = tarball, environment: NodeJS.ProcessEnv = {}) =>
      processes.run(
        process.execPath,
        [
          join(controller, "scripts/verify-release-artifact.mjs"),
          selected,
          version,
        ],
        {
          cwd: controller,
          env: { ...process.env, ...environment },
          timeoutMs: Math.min(2_147_483_647, preparationBudget + 30_000),
        },
      );
    const missing = await invoke();
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(missing.stderr).toMatch(/dist[/\\]catalogIdentity\.js/u);
    await symlink(
      resolve("dist"),
      join(controller, "dist"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const successful = await invoke();
    expect(successful.exitCode, successful.stderr).toBe(0);
    const result = JSON.parse(successful.stdout);
    expect(result).toMatchObject({
      package: "rea-agents",
      version,
      source: tarball,
      mcpTools: snapshot.tools.tools.length,
      clientSchemaEngines: "not_verified",
    });
    if (process.platform !== "win32")
      expect(result.verifier_run.process_lineage).toMatchObject({
        status: "verified",
        descendants: [],
      });
    // A complete catalog must not pass when the release requires the external
    // engines but its verifier runtime is missing the checker.
    const unchecked = await invoke(tarball, {
      REA_REQUIRE_SCHEMA_ENGINES: "1",
    });
    expect(unchecked.exitCode).toBe(1);
    expect(unchecked.stderr).toContain("verify-advertised-schemas.mjs");
    expect(unchecked.stderr).toContain("MODULE_NOT_FOUND");

    await installCheckerFixture(controller);
    const required = {
      REA_REQUIRE_SCHEMA_ENGINES: "1",
      REA_SCHEMA_ENGINES_PYTHON: "fixture-engine-python",
    };
    const verified = await invoke(tarball, required);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).clientSchemaEngines).toBe("verified");
    expect(verified.stderr).toContain(
      "fixture client validator accepted the installed catalog",
    );
    await writeFile(join(candidate, "scripts/refuse-schemas"), "");
    await pack();
    const refused = await invoke(tarball, required);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(
      "fixture client validator refused the installed catalog",
    );

    // Exercise the reported 6.9.0 pattern through the installed tarball, beyond
    // the in-process catalog tests. It is valid JSON Schema and V8 accepts it.
    const first = snapshot.tools.tools[0];
    if (first === undefined) throw new Error("Expected a catalog tool");
    const original = first.inputSchema;
    first.inputSchema = {
      type: "object",
      properties: {
        path: { type: "string", pattern: "^[^\\uD800-\\uDFFF]*$" },
      },
    };
    await writeFile(
      join(candidate, "scripts/reply.json"),
      JSON.stringify(snapshot),
    );
    await pack();
    const incompatible = await invoke();
    expect(incompatible.exitCode).toBe(1);
    expect(incompatible.stderr).toContain(
      "input pattern unicode-escape: 1 > 0",
    );
    first.inputSchema = original;
    // Repack with one omitted canonical tool; the real protocol still succeeds,
    // so only the independent release catalog assertion can reject this artifact.
    snapshot.tools.tools.pop();
    await writeFile(
      join(candidate, "scripts/reply.json"),
      JSON.stringify(snapshot),
    );
    await pack();
    const drifted = await invoke();
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stderr).toContain("invalid canonical tool catalog");
    await writeFile(
      join(candidate, "package.json"),
      JSON.stringify({
        name: "rea-agents",
        version: "0.0.0",
        type: "module",
        files: ["scripts"],
      }),
    );
    const wrong = await pack();
    const [{ filename: wrongFilename }] = z
      .tuple([z.object({ filename: z.string() })])
      .parse(JSON.parse(wrong.stdout));
    const mismatched = await invoke(join(candidate, wrongFilename));
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.stderr).toContain("Installed package identity");
  },
);
