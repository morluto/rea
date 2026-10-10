import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../dist/contracts/toolContracts.js";
import { exec } from "./lib/verify-package-core.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { createAnthropicModelFixture } from "./verify/clients/anthropic-model-fixture.mjs";

assert(
  process.platform !== "win32",
  "Native Claude Code verifier requires POSIX; Windows is unverified",
);
const repo = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.REA_VERIFY_RUNTIME_ROOT ?? repo;
const command = process.env.REA_VERIFY_CLAUDE_COMMAND ?? "claude";
const mode = process.argv[2] ?? "call";
assert(
  ["chat", "call"].includes(mode),
  "Usage: verify-claude-client.mjs [chat|call]",
);
const verifier = createVerifierRun();
const lab = await mkdtemp(join(tmpdir(), "rea-claude-client-"));
const profile = join(lab, "selected profile");
const workspace = join(lab, "workspace");
const configPath = join(profile, ".claude.json");
const skillDirectory = join(profile, "skills", "reverse-engineer-anything");
await Promise.all([mkdir(profile), mkdir(workspace)]);
await exec("git", ["init", "--quiet", workspace], { timeout: 30_000 });
const environment = {
  ...process.env,
  CLAUDE_CONFIG_DIR: profile,
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  REA_PROCESS_RUN_ID: verifier.run_id,
};
let clientVersion;
try {
  clientVersion = (
    await exec(command, ["--version"], { env: environment, timeout: 30_000 })
  ).stdout.trim();
} catch (cause) {
  throw new Error(
    `Claude Code preflight failed for ${command}; install Claude Code or set REA_VERIFY_CLAUDE_COMMAND. ${String(cause)}`,
  );
}
const target = join(lab, "fixture α测试");
await mkdir(target);
await writeFile(
  join(target, "app.js"),
  'export function result() { return { clientCompatibility: "REA_CLIENT_FIXTURE", count: 7 }; }\n',
);
let skillRequested = false;
let skillLoaded = false;
let expectedSkillBody;
let evidenceSeen = false;
let finalSeen = false;
let catalogSize = 0;
let schemasChecked = 0;
let pendingServerWaits = 0;
let artifactDigest;
const schemaValidator = new Ajv2020({ strict: false, validateFormats: false });
const containsText = (value, text) => {
  if (typeof value === "string") return value.includes(text);
  if (value && typeof value === "object")
    return Object.values(value).some((nested) => containsText(nested, text));
  return false;
};
const extractEvidence = (value) => {
  if (typeof value === "string") {
    try {
      // Native Claude appends this resource hint to tool results. Original bodies remain intact in request artifacts.
      const json = value.replace(
        /\n\n<system-reminder>\n<total_tokens>\d+ tokens left<\/total_tokens>\n<\/system-reminder>$/u,
        "",
      );
      return extractEvidence(JSON.parse(json));
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object") {
    if (
      typeof value.evidence_id === "string" &&
      value.normalized_result?.graph?.nodes?.length > 0
    )
      return value;
    for (const nested of Object.values(value)) {
      const evidence = extractEvidence(nested);
      if (evidence) return evidence;
    }
  }
  return undefined;
};
const fixture = await createAnthropicModelFixture({
  directory: lab,
  onRequest: async ({ body, tools, requestIndex }) => {
    if (tools.length === 0)
      return [{ type: "text", text: "REA fixture title" }];
    assert(requestIndex <= 8, "Local model workflow exceeded its turn budget");
    const call = (name, input) => [
      { type: "tool_use", id: `toolu_rea_${requestIndex}`, name, input },
    ];
    const analysis = tools.find((t) =>
      t.name.endsWith("analyze_javascript_application"),
    );
    if (!analysis) {
      // Native automatic discovery can begin the conversation while MCP is still connecting.
      const wait = tools.find((t) => t.name === "WaitForMcpServers");
      assert(
        wait,
        "Claude must expose REA tools or its native pending-server wait",
      );
      pendingServerWaits++;
      return call(wait.name, { servers: ["rea"] });
    }
    const prefix = analysis.name.slice(
      0,
      -"analyze_javascript_application".length,
    );
    const expected = TOOL_CONTRACTS.map((t) => prefix + t.name).sort();
    const reaTools = tools.filter((t) => t.name.startsWith(prefix));
    assert.deepEqual(
      reaTools.map((t) => t.name).sort(),
      expected,
      "Claude must forward the complete REA catalog after connection",
    );
    catalogSize = expected.length;
    if (schemasChecked === 0) {
      for (const tool of reaTools) {
        assert(
          tool.input_schema,
          `${tool.name}: missing advertised input schema`,
        );
        assert(
          schemaValidator.validateSchema(tool.input_schema),
          `${tool.name}: invalid input schema: ${JSON.stringify(schemaValidator.errors)}`,
        );
        schemasChecked++;
      }
    }
    skillLoaded ||=
      expectedSkillBody !== undefined &&
      containsText(body.messages, expectedSkillBody) &&
      containsText(body.messages, skillDirectory);
    const observed = extractEvidence(body.messages);
    if (observed) {
      const evidence = toolContract(
        "analyze_javascript_application",
      ).outputSchema.parse(observed);
      assert.equal(evidence.subject.local_path, target);
      const shape = evidence.normalized_result.graph.nodes
        .flatMap((n) => n.observations)
        .map((o) => o.properties)
        .find(
          (p) =>
            p.semantic_role === "export-return-shapes" &&
            p.exported_name === "result",
        );
      assert(shape?.return_shape_coverage?.projection_complete);
      const fields = shape.static_return_shapes.flatMap((s) => s.fields);
      assert(
        fields.some(
          (f) =>
            f.path === "/clientCompatibility" &&
            f.state === "literal" &&
            f.value === "REA_CLIENT_FIXTURE",
        ),
      );
      assert(
        fields.some(
          (f) => f.path === "/count" && f.state === "literal" && f.value === 7,
        ),
      );
      const bytes = JSON.stringify(evidence);
      artifactDigest = createHash("sha256").update(bytes).digest("hex");
      await writeFile(join(lab, "claude-evidence.json"), bytes);
      evidenceSeen = true;
    }
    if (mode === "chat" || evidenceSeen) {
      finalSeen = true;
      return [{ type: "text", text: "REA_CLIENT_COMPATIBILITY_OK" }];
    }
    if (!skillRequested) {
      const skill = tools.find((t) => t.name === "Skill");
      assert(skill, "Claude must expose its native Skill tool");
      skillRequested = true;
      return call(skill.name, { skill: "reverse-engineer-anything" });
    }
    assert(
      skillLoaded,
      "Claude must load the complete installed personal REA skill",
    );
    return call(analysis.name, { input_path: target, format: "directory" });
  },
});
const original = JSON.stringify({ theme: "light", mcpServers: {} }, null, 2);
await writeFile(configPath, original);
let failure;
try {
  for (const args of [
    ["setup", "--client", "claude_code", "--dry-run"],
    ["setup", "--client", "claude_code", "--yes"],
    ["doctor", "--client", "claude_code", "--skill"],
  ]) {
    const result = await exec(
      process.execPath,
      [join(runtimeRoot, "scripts/rea.mjs"), ...args, "--json"],
      { env: environment, cwd: workspace, timeout: 60_000 },
    );
    await writeFile(
      join(lab, `${args[0]}${args.includes("--dry-run") ? "-plan" : ""}.json`),
      result.stdout,
    );
    const parsed = JSON.parse(result.stdout);
    if (args[0] === "doctor") assert.equal(parsed.healthy, true);
    else {
      assert.equal(
        parsed.status,
        args.includes("--dry-run") ? "planned" : "ready",
      );
      if (args.includes("--dry-run")) {
        assert(parsed.plannedActions.some((a) => a.target === configPath));
        assert(parsed.plannedActions.some((a) => a.target === skillDirectory));
        assert(
          parsed.plannedActions.every(
            (a) =>
              a.target === configPath || a.target.startsWith(skillDirectory),
          ),
        );
      }
    }
  }
  assert.equal(await readFile(`${configPath}.rea.backup`, "utf8"), original);
  const configured = await readFile(configPath, "utf8");
  assert.equal(JSON.parse(configured).theme, "light");
  const repeated = await exec(
    process.execPath,
    [
      join(runtimeRoot, "scripts/rea.mjs"),
      "setup",
      "--client",
      "claude_code",
      "--yes",
      "--json",
    ],
    { env: environment, cwd: workspace, timeout: 60_000 },
  );
  assert.deepEqual(JSON.parse(repeated.stdout).appliedActions, []);
  assert.equal(await readFile(configPath, "utf8"), configured);
  assert.equal(await readFile(`${configPath}.rea.backup`, "utf8"), original);
  const installedSkill = await readFile(
    join(skillDirectory, "SKILL.md"),
    "utf8",
  );
  assert(installedSkill.includes("name: reverse-engineer-anything"));
  const lines = installedSkill.split("\n");
  const headerEnd = lines.indexOf("---", 1);
  assert(
    lines[0] === "---" && headerEnd > 0,
    "Installed skill must have its authored frontmatter",
  );
  expectedSkillBody = lines
    .slice(headerEnd + 1)
    .join("\n")
    .trim();
  assert(expectedSkillBody.length > 0);
  const execution = exec(
    command,
    [
      "--setting-sources",
      "user",
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      "claude-sonnet-4-6",
      "--tools",
      "default",
      "--permission-mode",
      "dontAsk",
      "--settings",
      JSON.stringify({
        permissions: {
          allow: [
            "Skill",
            "WaitForMcpServers",
            "mcp__rea__analyze_javascript_application",
          ],
        },
      }),
      mode === "chat"
        ? "Say hello briefly."
        : `Use the REA skill and tools to analyze the JavaScript directory ${target}. Report the result.`,
    ],
    {
      env: {
        ...environment,
        ANTHROPIC_API_KEY: "local-fixture-key",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: fixture.baseUrl,
      },
      cwd: workspace,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  execution.child.stdin.end();
  const response = await execution;
  await writeFile(join(lab, `${mode}.stdout`), response.stdout);
  await writeFile(join(lab, `${mode}.stderr`), response.stderr);
  assert.equal(fixture.failure, undefined);
  const parsed = JSON.parse(response.stdout);
  assert.equal(parsed.is_error, false);
  assert.equal(parsed.subtype, "success");
  assert.equal(parsed.result, "REA_CLIENT_COMPATIBILITY_OK");
  assert.deepEqual(parsed.permission_denials, []);
  assert(finalSeen);
  if (mode === "call") assert(evidenceSeen && skillLoaded);
} catch (cause) {
  failure = cause;
  if (typeof cause?.stdout === "string")
    await writeFile(join(lab, `${mode}.stdout`), cause.stdout);
  if (typeof cause?.stderr === "string")
    await writeFile(join(lab, `${mode}.stderr`), cause.stderr);
} finally {
  await fixture.close();
  const receipt = {
    client: "Claude Code",
    clientVersion,
    mode,
    passed: failure === undefined,
    artifacts: lab,
    runtimeRoot,
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
    },
    modelFixture:
      "loopback Anthropic Messages/SSE; synthetic usage and native resource hints; no live API claim",
    discovery:
      "native CLAUDE_CONFIG_DIR user configuration and skills; separate Git root, user settings only, default built-in tools",
    bareMode:
      "not used; native bare print mode did not load the personal skill",
    catalogSize,
    schemasChecked,
    pendingServerWaits,
    evidenceSeen,
    skillLoaded,
    artifactDigest,
    finalSeen,
    requests: fixture.requests,
    probes: fixture.probes,
    fixtureFailure: fixture.failure,
    verifier: await completeVerifierRun(verifier),
  };
  await writeFile(join(lab, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
if (failure !== undefined) throw failure;
