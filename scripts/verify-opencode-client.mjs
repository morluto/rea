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
import { createOpenAiModelFixture } from "./verify/clients/model-fixture.mjs";

assert(
  process.platform !== "win32",
  "Native OpenCode verifier requires POSIX; Windows is unverified",
);
const repo = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.REA_VERIFY_RUNTIME_ROOT ?? repo;
const command = process.env.REA_VERIFY_OPENCODE_COMMAND ?? "opencode";
const mode = process.argv[2] ?? "call";
const configFormat = process.env.REA_VERIFY_OPENCODE_CONFIG_FORMAT ?? "jsonc";
assert(
  ["chat", "call"].includes(mode),
  "Usage: verify-opencode-client.mjs [chat|call]",
);
assert(
  ["json", "jsonc"].includes(configFormat),
  "REA_VERIFY_OPENCODE_CONFIG_FORMAT must be json or jsonc",
);
const verifier = createVerifierRun();
const lab = await mkdtemp(join(tmpdir(), "rea-opencode-client-"));
const account = join(lab, "account");
const profile = join(lab, "selected profile");
const workspace = join(lab, "workspace");
const configPath = join(profile, `opencode.${configFormat}`);
const skillDirectory = join(
  account,
  ".agents",
  "skills",
  "reverse-engineer-anything",
);
await Promise.all([mkdir(account), mkdir(profile), mkdir(workspace)]);
await exec("git", ["init", "--quiet", workspace], { timeout: 30_000 });
const environment = {
  USERPROFILE: account,
  OPENCODE_CONFIG_DIR: profile,
  XDG_CONFIG_HOME: join(lab, "config"),
  XDG_CACHE_HOME: join(lab, "cache"),
  XDG_DATA_HOME: join(lab, "data"),
  XDG_STATE_HOME: join(lab, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  // Use the native core without external account plugins.
  OPENCODE_PURE: "true",
  REA_PROCESS_RUN_ID: verifier.run_id,
};
let clientVersion;
try {
  clientVersion = (
    await exec(command, ["--version"], { env: environment, timeout: 30_000 })
  ).stdout.trim();
} catch (cause) {
  throw new Error(
    `OpenCode preflight failed for ${command}; install OpenCode or set REA_VERIFY_OPENCODE_COMMAND. ${String(cause)}`,
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
let artifactDigest;
const schemaValidator = new Ajv2020({ strict: false, validateFormats: false });
const extractEvidence = (value) => {
  if (typeof value === "string") {
    try {
      return extractEvidence(JSON.parse(value));
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
const fixture = await createOpenAiModelFixture({
  directory: lab,
  prefix: "opencode",
  onRequest: async ({ body, tools, requestIndex }) => {
    // Native session-title requests do not execute the analyst's workflow.
    if (tools.length === 0)
      return { role: "assistant", content: "REA fixture title" };
    const analysis = tools.find((t) =>
      t.name.endsWith("analyze_javascript_application"),
    );
    assert(analysis, "OpenCode must expose the REA analysis tool");
    const prefix = analysis.name.slice(
      0,
      -"analyze_javascript_application".length,
    );
    const expected = TOOL_CONTRACTS.map((t) => prefix + t.name).sort();
    const reaTools = tools.filter((t) => expected.includes(t.name));
    assert.deepEqual(
      reaTools.map((t) => t.name).sort(),
      expected,
      "OpenCode must forward the complete REA catalog",
    );
    catalogSize = expected.length;
    if (schemasChecked === 0) {
      for (const tool of reaTools) {
        assert(
          tool.parameters,
          `${tool.name}: missing advertised input schema`,
        );
        assert(
          schemaValidator.validateSchema(tool.parameters),
          `${tool.name}: invalid input schema: ${JSON.stringify(schemaValidator.errors)}`,
        );
        schemasChecked++;
      }
    }
    const replies = body.messages.filter((m) => m.role === "tool");
    skillLoaded ||= replies.some(
      (m) =>
        typeof m.content === "string" &&
        expectedSkillBody !== undefined &&
        m.content.includes(skillDirectory) &&
        m.content.includes(expectedSkillBody),
    );
    const observed = extractEvidence(replies);
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
      await writeFile(join(lab, "opencode-evidence.json"), bytes);
      evidenceSeen = true;
    }
    if (mode === "chat" || evidenceSeen) {
      finalSeen = true;
      return { role: "assistant", content: "REA_CLIENT_COMPATIBILITY_OK" };
    }
    assert(requestIndex <= 8, "Local model workflow exceeded its turn budget");
    const call = (name, args) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_rea_fixture_${requestIndex}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    if (!skillRequested) {
      const skill = tools.find((t) => t.name === "skill");
      assert(skill, "OpenCode must expose its native skill tool");
      skillRequested = true;
      return call(skill.name, { name: "reverse-engineer-anything" });
    }
    assert(skillLoaded, "OpenCode must load the installed personal REA skill");
    return call(analysis.name, { input_path: target, format: "directory" });
  },
});
const original =
  (configFormat === "jsonc" ? "// Keep caller configuration.\n" : "") +
  JSON.stringify(
    {
      autoupdate: false,
      skills: { paths: [join(account, ".agents", "skills")] },
      permission: { "*": "allow" },
      provider: {
        "rea-fixture": {
          npm: "@ai-sdk/openai-compatible",
          name: "REA local model fixture",
          options: { baseURL: fixture.baseUrl, apiKey: "local-fixture-key" },
          models: {
            "rea-client-fixture": {
              name: "REA fixture",
              tool_call: true,
              limit: { context: 1_000_000, output: 4096 },
            },
          },
        },
      },
      mcp: {
        other: { type: "local", command: ["unrelated-server"], enabled: false },
      },
    },
    null,
    2,
  );
await writeFile(configPath, original);
let failure;
try {
  for (const args of [
    ["setup", "--client", "opencode", "--dry-run"],
    ["setup", "--client", "opencode", "--yes"],
    ["doctor", "--client", "opencode", "--skill"],
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
  assert(configured.includes("unrelated-server"));
  if (configFormat === "jsonc")
    assert(configured.includes("// Keep caller configuration."));
  const repeated = await exec(
    process.execPath,
    [
      join(runtimeRoot, "scripts/rea.mjs"),
      "setup",
      "--client",
      "opencode",
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
  const skillLines = installedSkill.split("\n");
  const headerEnd = skillLines.indexOf("---", 1);
  assert(
    skillLines[0] === "---" && headerEnd > 0,
    "Installed skill must have its authored frontmatter",
  );
  expectedSkillBody = skillLines
    .slice(headerEnd + 1)
    .join("\n")
    .trim();
  assert(expectedSkillBody.length > 0);
  const execution = exec(
    command,
    [
      "run",
      "--format",
      "json",
      "--model",
      "rea-fixture/rea-client-fixture",
      mode === "chat"
        ? "Say hello briefly."
        : `Use REA to analyze the JavaScript directory ${target}. Report the result.`,
    ],
    {
      env: environment,
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
  assert(finalSeen && response.stdout.includes("REA_CLIENT_COMPATIBILITY_OK"));
  if (mode === "call") assert(evidenceSeen && skillLoaded);
} catch (cause) {
  failure = cause;
  if (typeof cause?.stdout === "string")
    await writeFile(join(lab, `${mode}.stdout`), cause.stdout);
  if (typeof cause?.stderr === "string")
    await writeFile(join(lab, `${mode}.stderr`), cause.stderr);
} finally {
  await fixture.close();
  const lineage = await completeVerifierRun(verifier);
  const receipt = {
    client: "OpenCode",
    clientVersion,
    mode,
    configFormat,
    passed: failure === undefined,
    artifacts: lab,
    runtimeRoot,
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
    },
    modelFixture:
      "loopback custom OpenAI-compatible provider; one-million-token fixture capacity and synthetic usage; no live provider claim",
    skillDiscovery:
      "caller-configured isolated shared directory; default OS home discovery unverified",
    externalPlugins: "disabled through native OPENCODE_PURE",
    catalogSize,
    schemasChecked,
    evidenceSeen,
    skillLoaded,
    artifactDigest,
    finalSeen,
    requests: fixture.requests,
    probes: fixture.probes,
    fixtureFailure: fixture.failure,
    verifier: lineage,
  };
  await writeFile(join(lab, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
if (failure !== undefined) throw failure;
