import assert from "node:assert/strict";
import { createOpenAiModelFixture } from "./verify/clients/model-fixture.mjs";
import {
  mkdir,
  writeFile,
  readFile,
  mkdtemp,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { exec } from "./lib/verify-package-core.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../dist/contracts/toolContracts.js";

assert(
  process.platform !== "win32",
  "The Qwen real-client verifier currently requires a POSIX host; native Windows is unverified.",
);
const repo = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.REA_VERIFY_RUNTIME_ROOT ?? repo;
const lab = await mkdtemp(join(tmpdir(), "rea-qwen-client-"));
const client = "qwen";
const mode = process.argv[2] ?? "call";
assert(
  ["chat", "call"].includes(mode),
  "Usage: node scripts/verify-qwen-client.mjs [chat|call]",
);
const command = process.env.REA_VERIFY_QWEN_COMMAND ?? "qwen";
const verifier = createVerifierRun();
const profile = join(lab, "selected profile");
const account = join(lab, "account");
const runtime = join(profile, "runtime");
const workspace = join(lab, "workspace");
const sharedSkills = join(account, ".agents", "skills");
await Promise.all([
  mkdir(profile, { recursive: true }),
  mkdir(account),
  mkdir(workspace),
]);
const baseEnvironment = {
  PATH: process.env.PATH ?? "",
  USERPROFILE: account,
  QWEN_HOME: profile,
  QWEN_RUNTIME_DIR: runtime,
  REA_PROCESS_RUN_ID: verifier.run_id,
};
let clientVersion;
try {
  clientVersion = (
    await exec(command, ["--version"], {
      env: baseEnvironment,
      timeout: 30_000,
    })
  ).stdout.trim();
} catch (cause) {
  throw new Error(
    `Qwen client preflight failed for ${command}; install Qwen Code or set REA_VERIFY_QWEN_COMMAND. ${String(cause)}`,
  );
}
const original = JSON.stringify(
  {
    security: {
      auth: { selectedType: "openai" },
      folderTrust: { enabled: false },
    },
    telemetry: { enabled: false },
    model: { name: "rea-client-fixture" },
    // Qwen uses os.homedir(), while REA's isolated CLI account uses USERPROFILE.
    // This caller-owned setting lets the real client load the REA-installed bundle.
    skills: { directories: [sharedSkills] },
    mcpServers: { other: { command: "unrelated-server", disabled: true } },
  },
  null,
  2,
);
await writeFile(join(profile, "settings.json"), original);
for (const step of [
  ["setup", "--client", "qwen_code", "--dry-run"],
  ["setup", "--client", "qwen_code", "--yes"],
  ["doctor", "--client", "qwen_code", "--skill"],
]) {
  const response = await exec(
    process.execPath,
    [join(runtimeRoot, "scripts/rea.mjs"), ...step, "--json"],
    { env: baseEnvironment, cwd: repo, timeout: 60_000 },
  );
  const result = JSON.parse(response.stdout);
  if (step.includes("--dry-run"))
    assert(
      result.plannedActions.every(
        (a) =>
          a.target.startsWith(profile + "/") ||
          a.target.startsWith(sharedSkills + "/"),
      ),
    );
  await writeFile(
    join(lab, `${step[0]}${step.includes("--dry-run") ? "-plan" : ""}.json`),
    response.stdout,
  );
}
assert.equal(
  await readFile(join(profile, "settings.json.rea.backup"), "utf8"),
  original,
);
const configured = JSON.parse(
  await readFile(join(profile, "settings.json"), "utf8"),
);
assert.deepEqual(configured.model, { name: "rea-client-fixture" });
assert.deepEqual(configured.skills, { directories: [sharedSkills] });
assert.deepEqual(configured.mcpServers.other, {
  command: "unrelated-server",
  disabled: true,
});
const target = join(lab, "fixture α测试");
await mkdir(target, { recursive: true });
await writeFile(
  `${target}/app.js`,
  'export function result() { return { clientCompatibility: "REA_CLIENT_FIXTURE", count: 7 }; }\n',
);
let evidenceSeen = false;
let skillSeen = false;
let finalSeen = false;
let skillRequested = false;
let searchRequested = false;
let artifactReadByAgent = false;
let artifactPath;
let selectedSkillLoaded = false;
let artifactDigest;
const extractEvidence = (value) => {
  if (typeof value === "string") {
    try {
      return extractEvidence(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = extractEvidence(item);
      if (result) return result;
    }
  } else if (value && typeof value === "object") {
    if (
      typeof value.evidence_id === "string" &&
      value.normalized_result?.graph?.nodes?.length > 0
    )
      return value;
    for (const nested of Object.values(value)) {
      const result = extractEvidence(nested);
      if (result) return result;
    }
  }
  return null;
};
const fixture = await createOpenAiModelFixture({
  directory: lab,
  prefix: `${client}-${mode}`,
  onRequest: async ({ body, tools, requestIndex }) => {
    skillSeen ||= JSON.stringify(body.messages ?? []).includes(
      "reverse-engineer-anything",
    );
    selectedSkillLoaded ||= JSON.stringify(body.messages ?? []).includes(
      join(sharedSkills, "reverse-engineer-anything"),
    );
    const toolText = JSON.stringify(
      (body.messages ?? []).filter((m) => m.role === "tool"),
    );
    if (
      toolText.includes("REA_CLIENT_FIXTURE") &&
      /(?:\\?"REA_CLIENT_FIXTURE\\?"\s*:\s*true)/u.test(toolText)
    ) {
      artifactReadByAgent = true;
      assert(artifactPath);
      const artifact = await readFile(artifactPath);
      artifactDigest = createHash("sha256").update(artifact).digest("hex");
      const evidence = toolContract(
        "analyze_javascript_application",
      ).outputSchema.parse(JSON.parse(artifact.toString("utf8")));
      assert(extractEvidence(evidence));
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
      evidenceSeen = true;
      await writeFile(
        `${lab}/${client}-${mode}-evidence.json`,
        JSON.stringify(evidence),
      );
    }
    for (const message of body.messages ?? []) {
      if (message.role !== "tool") continue;
      const evidence = extractEvidence(message.content);
      if (evidence) {
        assert(
          JSON.stringify(evidence.normalized_result).includes(
            "REA_CLIENT_FIXTURE",
          ),
        );
        evidenceSeen = true;
        await writeFile(
          `${lab}/${client}-${mode}-evidence.json`,
          JSON.stringify(evidence),
        );
      }
    }
    const selected = tools.find((t) =>
      t.name.includes("analyze_javascript_application"),
    );
    const reviewedNames = [
      ...JSON.stringify(
        (body.messages ?? []).filter((m) => m.role === "tool"),
      ).matchAll(
        /(?:\\?"name\\?"\s*:\s*\\?")([^"\\]*analyze_javascript_application)(?:\\?")/g,
      ),
    ]
      .map((m) => m[1])
      .sort((a, b) => b.length - a.length);
    const search = tools.find((t) => t.name === "tool_search");
    const invoke = tools.find((t) => t.name === "tool_call");
    const skill = tools.find((t) => t.name === "skill");
    const shell = tools.find((t) => t.name === "run_shell_command");
    const persisted = toolText.match(
      /Full output saved to: ([^\\"\n]+)(?:\\n|\n)/u,
    );
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
    let message;
    if (mode === "chat" || evidenceSeen) {
      message = { role: "assistant", content: "REA_CLIENT_COMPATIBILITY_OK" };
      finalSeen = true;
    } else if (skill && !skillRequested) {
      skillRequested = true;
      message = call(skill.name, { skill: "reverse-engineer-anything" });
    } else if (persisted && shell) {
      artifactPath = persisted[1];
      assert(
        (await realpath(artifactPath)).startsWith(
          (await realpath(runtime)) + "/",
        ),
      );
      const script = `const fs=require('node:fs');const e=JSON.parse(fs.readFileSync(${JSON.stringify(artifactPath)},'utf8'));console.log(JSON.stringify({REA_CLIENT_FIXTURE:JSON.stringify(e.normalized_result).includes('REA_CLIENT_FIXTURE'),evidence_id:e.evidence_id,graph_nodes:e.normalized_result.graph.nodes.length}));`;
      const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
      message = call(shell.name, {
        command: `node -e ${quote(script)}`,
        description:
          "Read the complete saved REA Evidence and verify the fixture facts.",
      });
    } else if (selected)
      message = call(selected.name, {
        input_path: target,
        format: "directory",
      });
    else if (reviewedNames.length && invoke)
      message = call(invoke.name, {
        name: reviewedNames[0],
        arguments: { input_path: target, format: "directory" },
      });
    else if (search && !searchRequested) {
      searchRequested = true;
      message = call(search.name, { query: "analyze_javascript_application" });
    } else
      throw new Error(
        `REA analysis tool not exposed; tools: ${tools.map((t) => t.name).join(", ")}`,
      );
    return message;
  },
});
const endpoint = fixture.baseUrl;
const prompt =
  mode === "chat"
    ? "Say hello briefly."
    : `Use REA to analyze the JavaScript directory ${target}. Report the result.`;
const env = {
  ...baseEnvironment,
  OPENAI_API_KEY: "local-fixture-key",
  OPENAI_BASE_URL: endpoint,
};
const args = [
  "--auth-type",
  "openai",
  "--openai-base-url",
  endpoint,
  "--model",
  "rea-client-fixture",
  "--approval-mode",
  mode === "chat" ? "default" : "yolo",
  "--allowed-mcp-server-names",
  "rea",
  "--output-format",
  "stream-json",
  "--max-session-turns",
  "8",
  "-p",
  prompt,
];
let response;
let failure;
try {
  response = await exec(command, args, {
    env,
    cwd: workspace,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  await writeFile(join(lab, `${mode}.stdout`), response.stdout);
  await writeFile(join(lab, `${mode}.stderr`), response.stderr);
  const initialized = response.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((v) => v.type === "system" && v.subtype === "init");
  assert(initialized);
  const observed = initialized.tools
    .filter((n) => n.startsWith("mcp__rea__"))
    .sort();
  assert.deepEqual(
    observed,
    TOOL_CONTRACTS.map((c) => `mcp__rea__${c.name}`).sort(),
    "Qwen must discover the complete REA catalog",
  );
  assert.equal(fixture.failure, undefined);
  assert(finalSeen);
  if (mode === "call") {
    assert(evidenceSeen);
    assert(selectedSkillLoaded);
    assert(artifactReadByAgent);
  }
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
    client: "Qwen Code",
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
      "loopback deterministic OpenAI-compatible endpoint; no live model-provider claim",
    skillDiscovery:
      "caller-configured isolated shared directory; default OS home discovery unverified",
    catalogSize: TOOL_CONTRACTS.length,
    requests: fixture.requests,
    probes: fixture.probes,
    evidenceSeen,
    selectedSkillLoaded,
    artifactReadByAgent,
    artifactPath,
    artifactDigest,
    finalSeen,
    fixtureFailure: fixture.failure,
    verifier: lineage,
  };
  await writeFile(join(lab, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
if (failure !== undefined) throw failure;
