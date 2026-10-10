import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../dist/contracts/toolContracts.js";
import { exec } from "./lib/verify-package-core.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { createOpenAiModelFixture } from "./verify/clients/model-fixture.mjs";

const mode = process.argv[2] ?? "call";
assert(["chat", "call"].includes(mode), "Select chat or call.");
assert(process.platform !== "win32", "Native Windows coverage is unverified.");
const repo = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.REA_VERIFY_RUNTIME_ROOT ?? repo;
const command = process.env.REA_VERIFY_DEEPSEEK_COMMAND ?? "dsh";
const lab = await mkdtemp(join(tmpdir(), "rea-deepseek-client-"));
const account = join(lab, "account");
const profile = join(lab, "selected profile");
const workspace = join(lab, "workspace");
const target = join(workspace, "fixture α测试");
const skillPath = join(
  account,
  ".agents",
  "skills",
  "reverse-engineer-anything",
  "SKILL.md",
);
const cli = join(runtimeRoot, "scripts", "rea.mjs");
const verifier = createVerifierRun();
await Promise.all([
  mkdir(account),
  mkdir(profile),
  mkdir(target, { recursive: true }),
]);
const environment = {
  PATH: process.env.PATH ?? "",
  USERPROFILE: account,
  DSH_HOME: profile,
  DSH_AGENTS_HOME: join(account, ".agents"),
  OPENAI_API_KEY: "local-fixture-key",
  REA_PROCESS_RUN_ID: verifier.run_id,
};
// A temporary directory under the checkout must not inherit its project skills or AGENTS.md.
await exec(
  "git",
  ["-c", "init.defaultBranch=main", "init", "--quiet", workspace],
  {
    env: environment,
    timeout: 30_000,
  },
);
await writeFile(
  join(target, "app.js"),
  'export function result() { return { clientCompatibility: "REA_CLIENT_FIXTURE", count: 7 }; }\n',
);
const clientVersion = (
  await exec(command, ["--version"], {
    env: environment,
    cwd: workspace,
    timeout: 30_000,
  })
).stdout.trim();
for (const args of [
  ["setup", "--skill", "--dry-run"],
  ["setup", "--skill", "--yes"],
]) {
  const result = await exec(process.execPath, [cli, ...args, "--json"], {
    env: environment,
    cwd: workspace,
    timeout: 60_000,
  });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, args.includes("--dry-run") ? "planned" : "ready");
  if (args.includes("--dry-run")) {
    assert.equal(parsed.plannedActions.length, 1);
    assert.equal(parsed.plannedActions[0].kind, "install_skill");
    assert.equal(parsed.plannedActions[0].target, dirname(skillPath));
  }
  await writeFile(
    join(lab, args.includes("--dry-run") ? "setup-plan.json" : "setup.json"),
    result.stdout,
  );
}
assert(
  (await readFile(skillPath, "utf8")).includes(
    "name: reverse-engineer-anything",
  ),
);

let catalog;
let patternCount = 0;
let skillRequested = false;
let skillLoaded = false;
let evidenceSeen = false;
let finalSeen = false;
let artifactDigest;
let mainRequests = 0;
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const patterns = new Set();
const validatePatterns = (value) => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "pattern" && typeof child === "string") {
      // Check the representation the native client actually forwards to its model adapter.
      for (const flags of ["", "u", "v"]) new RegExp(child, flags);
      patterns.add(child);
      patternCount++;
    } else validatePatterns(child);
  }
};
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
      value.normalized_result?.graph?.nodes
    )
      return value;
    for (const child of Object.values(value)) {
      const found = extractEvidence(child);
      if (found) return found;
    }
  }
};
const fixture = await createOpenAiModelFixture({
  directory: lab,
  prefix: `deepseek-${mode}`,
  onRequest: async ({ body, tools, requestIndex }) => {
    // Harness generates a session title in a separate, tool-free model request.
    if (tools.length === 0)
      return { role: "assistant", content: "REA validation" };
    assert(
      ++mainRequests <= 4,
      "Harness did not complete the bounded fixture workflow.",
    );
    const rea = tools.filter((tool) => tool.name.startsWith("mcp__rea__"));
    const observedCatalog = rea
      .map((tool) => tool.name.slice("mcp__rea__".length))
      .sort();
    assert.deepEqual(
      observedCatalog,
      TOOL_CONTRACTS.map((tool) => tool.name).sort(),
    );
    if (catalog === undefined) {
      catalog = observedCatalog;
      for (const tool of rea) {
        assert(
          ajv.validateSchema(tool.parameters),
          `${tool.name}: ${ajv.errorsText(ajv.errors)}`,
        );
        validatePatterns(tool.parameters);
      }
      assert(
        patternCount > 0,
        "The advertised regex constraints must reach the model.",
      );
    }
    const toolMessages = (body.messages ?? []).filter(
      (message) => message.role === "tool",
    );
    const serialized = JSON.stringify(toolMessages);
    skillLoaded ||=
      serialized.includes(
        '<skill_content name=\\"reverse-engineer-anything\\">',
      ) && serialized.includes(dirname(skillPath));
    for (const message of toolMessages) {
      const found = extractEvidence(message.content);
      if (found === undefined) continue;
      const evidence = toolContract(
        "analyze_javascript_application",
      ).outputSchema.parse(found);
      assert.equal(evidence.subject.local_path, target);
      const shape = evidence.normalized_result.graph.nodes
        .flatMap((node) => node.observations)
        .map((observation) => observation.properties)
        .find(
          (properties) =>
            properties.semantic_role === "export-return-shapes" &&
            properties.exported_name === "result",
        );
      assert(shape?.return_shape_coverage?.projection_complete);
      const fields = shape.static_return_shapes.flatMap(
        (entry) => entry.fields,
      );
      assert(
        fields.some(
          (field) =>
            field.path === "/clientCompatibility" &&
            field.state === "literal" &&
            field.value === "REA_CLIENT_FIXTURE",
        ),
      );
      assert(
        fields.some(
          (field) =>
            field.path === "/count" &&
            field.state === "literal" &&
            field.value === 7,
        ),
      );
      const text = JSON.stringify(evidence);
      await writeFile(join(lab, "evidence.json"), text);
      artifactDigest = createHash("sha256").update(text).digest("hex");
      evidenceSeen = true;
    }
    if (mode === "chat" || evidenceSeen) {
      finalSeen = true;
      return { role: "assistant", content: "REA_CLIENT_COMPATIBILITY_OK" };
    }
    const call = (name, args) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_rea_${requestIndex}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    if (!skillRequested) {
      assert(tools.some((tool) => tool.name === "skill"));
      skillRequested = true;
      return call("skill", { name: "reverse-engineer-anything" });
    }
    assert(
      skillLoaded,
      "Harness must load the installed skill before analysis.",
    );
    return call("mcp__rea__analyze_javascript_application", {
      input_path: target,
      format: "directory",
    });
  },
});
let failure;
try {
  // Use the client's native Cordis patch DSL; generic `rea setup --client` does not edit it.
  await writeFile(
    join(profile, "cordis.patch.yml"),
    `
- id: llm-pi-ai
  config:
    providers:
      rea-fixture:
        apiKeyEnv: OPENAI_API_KEY
        api: openai-completions
        baseURL: ${fixture.baseUrl}
        defaultMaxTokens: 4096
        retryPolicy:
          mode: normal
          maxRetries: 0
        models:
          - id: rea-client-fixture
            contextWindow: 1000000
- id: agent-default-model
  config:
    provider: rea-fixture
    model: rea-client-fixture
- insert:
    - id: rea-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rea
        transport: stdio
        command: ${JSON.stringify(process.execPath)}
        args: ${JSON.stringify([cli, "mcp"])}
        cwd: !!js process.cwd()
        env:
          REA_PROCESS_RUN_ID: ${JSON.stringify(verifier.run_id)}
`,
  );
  const execution = exec(
    command,
    [
      "--profile",
      "headless",
      "--json",
      mode === "chat" ? "Say hello briefly." : `Use REA to analyze ${target}.`,
    ],
    {
      env: environment,
      cwd: workspace,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  execution.child.stdin.end();
  const result = await execution;
  await writeFile(join(lab, "client.stdout"), result.stdout);
  await writeFile(join(lab, "client.stderr"), result.stderr);
  assert.equal(fixture.failure, undefined);
  assert(finalSeen && result.stdout.includes("REA_CLIENT_COMPATIBILITY_OK"));
  if (mode === "call") assert(evidenceSeen && skillLoaded);
} catch (cause) {
  failure = cause;
  if (typeof cause?.stdout === "string")
    await writeFile(join(lab, "client.stdout"), cause.stdout);
  if (typeof cause?.stderr === "string")
    await writeFile(join(lab, "client.stderr"), cause.stderr);
} finally {
  await fixture.close();
  const receipt = {
    client: "deepseek-harness",
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
      "loopback custom OpenAI-compatible adapter; no live DeepSeek provider claim",
    modelContextWindow: 1000000,
    skillDiscovery:
      "native DSH_AGENTS_HOME personal directory; isolated project root",
    catalogSize: catalog?.length,
    patternCount,
    uniquePatterns: patterns.size,
    skillLoaded,
    evidenceSeen,
    artifactDigest,
    finalSeen,
    requests: fixture.requests,
    fixtureFailure: fixture.failure,
    verifier: await completeVerifierRun(verifier),
  };
  await writeFile(join(lab, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
if (failure !== undefined) throw failure;
