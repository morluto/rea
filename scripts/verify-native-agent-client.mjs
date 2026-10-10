import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../dist/contracts/toolContracts.js";
import { exec } from "./lib/verify-package-core.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { createOpenAiModelFixture } from "./verify/clients/model-fixture.mjs";

const client = process.argv[2];
const mode = process.argv[3] ?? "call";
assert(["pi", "hermes"].includes(client), "Select pi or hermes.");
assert(["chat", "call"].includes(mode), "Select chat or call.");
assert(
  process.platform !== "win32",
  "This real-client lane requires POSIX; native Windows is unverified.",
);
const repo = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.REA_VERIFY_RUNTIME_ROOT ?? repo;
const command =
  process.env[`REA_VERIFY_${client.toUpperCase()}_COMMAND`] ?? client;
const lab = await mkdtemp(join(tmpdir(), `rea-${client}-client-`));
const account = join(lab, "account");
const profile = join(lab, "selected profile");
const stickyHermes =
  client === "hermes" && process.env.REA_VERIFY_HERMES_STICKY_PROFILE === "1";
const selectedProfile = stickyHermes
  ? join(profile, "profiles", "coder")
  : profile;
const workspace = join(lab, "workspace");
const target = join(workspace, "fixture α测试");
const artifactPath = join(workspace, "evidence.json");
const skillPath = join(
  client === "pi" ? join(account, ".agents") : selectedProfile,
  "skills",
  "reverse-engineer-anything",
  "SKILL.md",
);
const verifier = createVerifierRun();
await Promise.all([
  mkdir(account),
  mkdir(profile, { recursive: true }),
  ...(stickyHermes ? [mkdir(selectedProfile, { recursive: true })] : []),
  mkdir(target, { recursive: true }),
]);
await writeFile(
  join(target, "app.js"),
  'export function result() { return { clientCompatibility: "REA_CLIENT_FIXTURE", count: 7 }; }\n',
);
const environment = {
  PATH: process.env.PATH ?? "",
  USERPROFILE: account,
  [client === "pi" ? "PI_CODING_AGENT_DIR" : "HERMES_HOME"]: profile,
  PI_OFFLINE: "1",
  REA_PROCESS_RUN_ID: verifier.run_id,
};
const configPath = join(
  selectedProfile,
  client === "pi" ? "mcp.json" : "config.yaml",
);
if (stickyHermes) await writeFile(join(profile, "active_profile"), "coder\n");
const original =
  client === "pi"
    ? JSON.stringify({
        mcpServers: { other: { command: "unrelated-server", enabled: false } },
      })
    : "# Keep caller settings.\nmcp_servers:\n  other:\n    command: unrelated-server\n    enabled: false\n";
await writeFile(configPath, original);
if (client === "pi") {
  // The CLI fixture account and native os.homedir() differ; use Pi's caller-owned skill setting.
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({ skills: [join(account, ".agents", "skills")] }),
  );
}
const clientVersion = (
  await exec(command, ["--version"], { env: environment, timeout: 30_000 })
).stdout.trim();
for (const args of [
  ["setup", "--client", client, "--dry-run"],
  ["setup", "--client", client, "--yes"],
  ["doctor", "--client", client, "--skill"],
]) {
  const result = await exec(
    process.execPath,
    [join(runtimeRoot, "scripts/rea.mjs"), ...args, "--json"],
    { env: environment, cwd: workspace, timeout: 60_000 },
  );
  const parsed = JSON.parse(result.stdout);
  if (args[0] === "doctor") assert.equal(parsed.healthy, true);
  else
    assert.equal(
      parsed.status,
      args.includes("--dry-run") ? "planned" : "ready",
    );
  await writeFile(
    join(lab, `${args[0]}${args.includes("--dry-run") ? "-plan" : ""}.json`),
    result.stdout,
  );
}
assert.equal(await readFile(`${configPath}.rea.backup`, "utf8"), original);
const installedConfiguration = await readFile(configPath, "utf8");
assert(installedConfiguration.includes("unrelated-server"));
if (client === "hermes")
  assert(installedConfiguration.includes("# Keep caller settings."));
const repeated = await exec(
  process.execPath,
  [
    join(runtimeRoot, "scripts/rea.mjs"),
    "setup",
    "--client",
    client,
    "--yes",
    "--json",
  ],
  { env: environment, cwd: workspace, timeout: 60_000 },
);
assert.deepEqual(JSON.parse(repeated.stdout).appliedActions, []);
assert.equal(await readFile(configPath, "utf8"), installedConfiguration);
assert.equal(await readFile(`${configPath}.rea.backup`, "utf8"), original);
assert(
  (await readFile(skillPath, "utf8")).includes(
    "name: reverse-engineer-anything",
  ),
);
let evidenceSeen = false;
let skillLoaded = false;
let skillRequested = false;
let callRequested = false;
let searchRequested = false;
let describeRequested = false;
let finalSeen = false;
let catalog;
let artifactDigest;
const extractEvidence = (value) => {
  if (typeof value === "string") {
    if (
      value.startsWith("<untrusted_tool_result ") &&
      value.endsWith("</untrusted_tool_result>")
    ) {
      // Hermes wraps external MCP content with its own instruction banner.
      // Decode only that observed envelope, retaining the original request artifact.
      const start = value.indexOf("\n\n");
      if (start >= 0)
        return extractEvidence(
          value
            .slice(start + 2, value.lastIndexOf("</untrusted_tool_result>"))
            .trim(),
        );
    }
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
const validateEvidence = async (value) => {
  const evidence = toolContract(
    "analyze_javascript_application",
  ).outputSchema.parse(value);
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
  const serialized = JSON.stringify(evidence);
  await writeFile(join(lab, "evidence.json"), serialized);
  artifactDigest = createHash("sha256").update(serialized).digest("hex");
  evidenceSeen = true;
};
const fixture = await createOpenAiModelFixture({
  directory: lab,
  prefix: `${client}-${mode}`,
  onRequest: async ({ body, tools, requestIndex }) => {
    assert(
      requestIndex <= 6,
      "Client did not complete the bounded fixture workflow.",
    );
    const messages = body.messages ?? [];
    const toolMessages = messages.filter((m) => m.role === "tool");
    const serializedTools = JSON.stringify(toolMessages);
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
    if (
      client === "pi" &&
      callRequested &&
      serializedTools.includes("REA_CLIENT_FIXTURE")
    ) {
      const fact = toolMessages
        .flatMap((m) => {
          const text =
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content);
          const marker = text.indexOf('{"REA_CLIENT_FIXTURE":true');
          if (marker < 0) return [];
          const end = text.indexOf("}\n", marker);
          try {
            return [
              JSON.parse(text.slice(marker, end < 0 ? undefined : end + 1)),
            ];
          } catch {
            return [];
          }
        })
        .find((v) => Array.isArray(v.catalog));
      assert(
        fact,
        "Pi codemode must return its actual catalog and skill-read receipt.",
      );
      catalog = fact.catalog;
      skillLoaded = fact.skill_loaded === true;
      await validateEvidence(JSON.parse(await readFile(artifactPath, "utf8")));
    } else if (client === "hermes") {
      const search = tools.find((t) => t.name === "tool_search");
      const exposed = tools
        .filter((t) => t.name.startsWith("mcp__rea__"))
        .map((t) => t.name.slice(10));
      const deferred = [
        ...(search?.description ?? "").matchAll(/^- mcp__rea__(\w+):/gmu),
      ].map((m) => m[1]);
      const native = [...new Set([...exposed, ...deferred])];
      // Hermes advertises MCP prompt utilities beside server tools.
      if (native.length)
        catalog = native.filter(
          (name) => !["get_prompt", "list_prompts"].includes(name),
        );
      skillLoaded ||=
        serializedTools.includes(skillPath) &&
        serializedTools.includes("reverse-engineer-anything");
      for (const message of toolMessages) {
        const evidence = extractEvidence(message.content);
        if (evidence) await validateEvidence(evidence);
      }
    }
    if (mode === "chat" || evidenceSeen) {
      finalSeen = true;
      return { role: "assistant", content: "REA_CLIENT_COMPATIBILITY_OK" };
    }
    if (client === "pi") {
      const tool = tools.find((t) => t.name === "codemode");
      assert(
        tool,
        `Native Pi codemode unavailable: ${tools.map((t) => t.name).join(", ")}`,
      );
      assert(
        JSON.stringify(messages).includes(skillPath),
        "Pi must advertise the installed REA skill.",
      );
      callRequested = true;
      return call(tool.name, {
        code: `await describeNamespace("rea"); const skill = await tools.read({path:${JSON.stringify(skillPath)}}); const result = await tools.mcp__rea__analyze_javascript_application({input_path:${JSON.stringify(target)},format:"directory"}); if(result.isError) throw new Error(JSON.stringify(result)); const evidence = result.structuredContent ?? JSON.parse(result.content.find(c=>c.type==="text").text); await tools.write({path:${JSON.stringify(artifactPath)},content:JSON.stringify(evidence)}); text({REA_CLIENT_FIXTURE:true,skill_loaded:typeof skill==="string"&&skill.includes("name: reverse-engineer-anything"),catalog:ALL_TOOLS.filter(t=>t.name.startsWith("mcp__rea__")).map(t=>t.name.slice(10))});`,
      });
    }
    if (!skillRequested) {
      const tool = tools.find((t) => t.name === "skill_view");
      assert(tool, "Hermes skill_view must be available.");
      skillRequested = true;
      return call(tool.name, { name: "reverse-engineer-anything" });
    }
    if (!searchRequested) {
      const tool = tools.find((t) => t.name === "tool_search");
      assert(tool, "Hermes native deferred tool_search must be available.");
      searchRequested = true;
      return call(tool.name, { queries: ["analyze_javascript_application"] });
    }
    assert(
      serializedTools.includes("mcp__rea__analyze_javascript_application"),
      "Hermes must discover the analysis tool.",
    );
    if (!describeRequested) {
      const tool = tools.find((t) => t.name === "tool_describe");
      assert(tool, "Hermes must load the actual parameter schema.");
      describeRequested = true;
      return call(tool.name, {
        names: ["mcp__rea__analyze_javascript_application"],
      });
    }
    const tool = tools.find((t) => t.name === "tool_call");
    assert(tool, "Hermes native deferred tool_call must be available.");
    callRequested = true;
    return call(tool.name, {
      calls: [
        {
          name: "mcp__rea__analyze_javascript_application",
          arguments: { input_path: target, format: "directory" },
        },
      ],
    });
  },
});
if (client === "pi") {
  await writeFile(
    join(profile, "models.json"),
    JSON.stringify({
      providers: {
        "rea-fixture": {
          baseUrl: fixture.baseUrl,
          api: "openai-completions",
          apiKey: "local-fixture-key",
          models: [
            {
              id: "rea-client-fixture",
              reasoning: false,
              contextWindow: 200000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
} else {
  const configured = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    configured +
      `\nmodel:\n  default: rea-client-fixture\n  provider: custom\n  base_url: ${fixture.baseUrl}\nagent:\n  max_turns: 6\n`,
  );
}
const args =
  client === "pi"
    ? [
        "--offline",
        "--provider",
        "rea-fixture",
        "--model",
        "rea-client-fixture",
        "--no-session",
        "--no-context-files",
        "--mode",
        "json",
        "-p",
        mode === "chat"
          ? "Say hello briefly."
          : `Use REA to analyze ${target}.`,
      ]
    : [
        "--oneshot",
        mode === "chat"
          ? "Say hello briefly."
          : `Use REA to analyze ${target}.`,
        "--provider",
        "custom",
        "--model",
        "rea-client-fixture",
        "--reasoning",
        "none",
      ];
let failure;
try {
  const execution = exec(command, args, {
    env: {
      ...environment,
      OPENAI_API_KEY: "local-fixture-key",
      OPENAI_BASE_URL: fixture.baseUrl,
    },
    cwd: workspace,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  // Pi consumes piped input before its first prompt; an unused open pipe is not EOF.
  execution.child.stdin.end();
  const result = await execution;
  await writeFile(join(lab, "client.stdout"), result.stdout);
  await writeFile(join(lab, "client.stderr"), result.stderr);
  assert.equal(fixture.failure, undefined);
  assert(finalSeen);
  assert(result.stdout.includes("REA_CLIENT_COMPATIBILITY_OK"));
  if (mode === "call") {
    assert(evidenceSeen);
    assert(
      skillLoaded,
      "Native client must actually read the installed skill.",
    );
    assert.deepEqual(
      catalog?.sort(),
      TOOL_CONTRACTS.map((t) => t.name).sort(),
      "The complete REA catalog must survive native client discovery.",
    );
  }
} catch (cause) {
  failure = cause;
  if (typeof cause?.stdout === "string")
    await writeFile(join(lab, "client.stdout"), cause.stdout);
  if (typeof cause?.stderr === "string")
    await writeFile(join(lab, "client.stderr"), cause.stderr);
} finally {
  await fixture.close();
  const receipt = {
    client,
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
      "loopback deterministic OpenAI-compatible endpoint; no live provider claim",
    skillDiscovery:
      client === "pi"
        ? "caller-configured isolated shared directory; default OS home discovery unverified"
        : "native HERMES_HOME personal directory",
    stickyHermes,
    catalogSize: catalog?.length,
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
