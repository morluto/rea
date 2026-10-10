import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
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
  "This verifier requires a disposable POSIX account; Windows is unverified",
);
const account = process.env.REA_VERIFY_COMMANDCODE_ACCOUNT_HOME;
assert(
  account && isAbsolute(account) && account === homedir(),
  "Run as a disposable account whose actual OS home matches REA_VERIFY_COMMANDCODE_ACCOUNT_HOME; do not override HOME",
);
assert.equal(
  await readFile(join(account, ".rea-client-verification"), "utf8"),
  "Disposable REA client verification account\n",
);
const repo = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.REA_VERIFY_RUNTIME_ROOT ?? repo;
const command = process.env.REA_VERIFY_COMMANDCODE_COMMAND ?? "cmd";
const mode = process.argv[2] ?? "call";
assert(
  ["chat", "call"].includes(mode),
  "Usage: verify-commandcode-client.mjs [chat|call]",
);
const verifier = createVerifierRun();
const lab = await mkdtemp(join(account, "rea-commandcode-client-"));
const workspace = join(lab, "workspace");
const target = join(workspace, "fixture α测试");
const profile = join(account, ".commandcode");
const configPath = join(profile, "mcp.json");
const skillDirectory = join(
  account,
  ".agents",
  "skills",
  "reverse-engineer-anything",
);
await Promise.all([
  mkdir(target, { recursive: true }),
  mkdir(profile, { recursive: true }),
  mkdir(join(lab, "tmp")),
]);
await exec("git", ["init", "--quiet", workspace], { timeout: 30_000 });
await writeFile(
  join(target, "app.js"),
  'export function result() { return { clientCompatibility: "REA_CLIENT_FIXTURE", count: 7 }; }\n',
);
const environment = {
  PATH: process.env.PATH,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  USERPROFILE: account,
  TMPDIR: join(lab, "tmp"),
  CMD_LOCAL_ONLY: "1",
  // Native print mode checks for an account key even with a keyless BYOK model.
  // This synthetic value is never a real credential; local-only refuses hosted API calls.
  COMMAND_CODE_API_KEY: "local-fixture-only",
  COMMANDCODE_SKIP_UPDATES: "1",
  COMMANDCODE_DISABLE_CRON: "1",
  OTEL_SDK_DISABLED: "true",
  REA_PROCESS_RUN_ID: verifier.run_id,
};
const expectedNames = TOOL_CONTRACTS.map(
  (tool) => "mcp__rea__" + tool.name,
).sort();
const schemaValidator = new Ajv2020({ strict: false, validateFormats: false });
const textValues = (value) =>
  typeof value === "string"
    ? [value]
    : value !== null && typeof value === "object"
      ? Object.values(value).flatMap(textValues)
      : [];
let clientVersion;
let expectedSkill;
let inventoryChecked = false;
let skillLoaded = false;
let schemasChecked = 0;
let catalogArtifact;
let catalogDigest;
let catalogProjection;
let artifactProjectionSeen = false;
let evidenceSeen = false;
let evidenceBytes;
let finalSeen = false;
let stage = 0;
let failure;
const call = (name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: `call_commandcode_${++stage}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const validateCatalog = async (text) => {
  const entries = [
    ...text.matchAll(
      /^### (mcp__rea__[A-Za-z0-9_]+)\n[\s\S]*?\nParameters:\n```json\n([\s\S]*?)\n```/gm,
    ),
  ];
  assert.deepEqual(
    entries.map((entry) => entry[1]).sort(),
    expectedNames,
    "Native exact-name search must return every REA input schema",
  );
  for (const entry of entries) {
    const schema = JSON.parse(entry[2]);
    assert(
      schemaValidator.validateSchema(schema),
      `${entry[1]}: invalid native schema: ${JSON.stringify(schemaValidator.errors)}`,
    );
  }
  schemasChecked = entries.length;
  catalogDigest = createHash("sha256").update(text).digest("hex");
  await writeFile(join(lab, "native-catalog.md"), text);
};
const fixture = await createOpenAiModelFixture({
  directory: lab,
  prefix: "commandcode",
  onRequest: async ({ body, tools }) => {
    assert(tools.some((tool) => tool.name === "search_tools"));
    const strings = textValues(body.messages);
    if (!inventoryChecked) {
      const names = [
        ...new Set(
          strings.flatMap(
            (text) => text.match(/mcp__rea__[A-Za-z0-9_]+/g) ?? [],
          ),
        ),
      ].sort();
      assert.deepEqual(
        names,
        expectedNames,
        "Default native deferred-tool prompt must advertise the complete REA inventory",
      );
      assert.equal(
        tools.filter((tool) => tool.name.startsWith("mcp__rea__")).length,
        0,
        "Keep native lazy schema delivery enabled",
      );
      assert(
        tools
          .find((tool) => tool.name === "activate_skill")
          ?.parameters.properties.name.enum.includes(
            "reverse-engineer-anything",
          ),
      );
      inventoryChecked = true;
    }
    if (mode === "chat") {
      assert.equal(
        body.messages.filter((message) => message.role === "tool").length,
        0,
      );
      finalSeen = true;
      return { role: "assistant", content: "REA_CLIENT_COMPATIBILITY_OK" };
    }
    if (stage === 0)
      return call("activate_skill", { name: "reverse-engineer-anything" });
    assert(
      strings.some((text) => text.includes(expectedSkill)),
      "The model must receive the complete activated skill body",
    );
    skillLoaded = true;
    const last = body.messages
      .filter((message) => message.role === "tool")
      .at(-1)?.content;
    assert.equal(typeof last, "string");
    if (stage === 1)
      return call("search_tools", {
        query: "select:" + expectedNames.join(","),
      });
    if (stage === 2) {
      const spill = last.match(
        /\[full output saved to: (.+?) — read it with read_file/,
      );
      if (spill) {
        catalogArtifact = spill[1];
        const child = relative(environment.TMPDIR, catalogArtifact);
        assert(
          isAbsolute(catalogArtifact) &&
            child &&
            !child.startsWith("..") &&
            !isAbsolute(child),
          "Native spill must remain inside this run's temporary directory",
        );
        const text = await readFile(catalogArtifact, "utf8");
        await validateCatalog(text);
        catalogProjection = { schemas: schemasChecked, sha256: catalogDigest };
        const query =
          "const fs=require('node:fs'),crypto=require('node:crypto');const text=fs.readFileSync(process.argv[1],'utf8');const schemas=[...text.matchAll(/^### (mcp__rea__[A-Za-z0-9_]+)\\n/gm)].length;console.log(JSON.stringify({rea_catalog:{schemas,sha256:crypto.createHash('sha256').update(text).digest('hex')}}));";
        return call("shell_command", {
          command: process.execPath,
          args: ["-e", query, catalogArtifact],
        });
      }
      await validateCatalog(last);
      return call("mcp__rea__analyze_javascript_application", {
        input_path: target,
        format: "directory",
      });
    }
    if (catalogArtifact && !artifactProjectionSeen) {
      const line = last
        .split("\n")
        .find((item) => item.startsWith('{"rea_catalog":'));
      assert(line, "Native shell must return the selected saved-catalog facts");
      assert.deepEqual(JSON.parse(line).rea_catalog, catalogProjection);
      artifactProjectionSeen = true;
      return call("mcp__rea__analyze_javascript_application", {
        input_path: target,
        format: "directory",
      });
    }
    const evidence = toolContract(
      "analyze_javascript_application",
    ).outputSchema.parse(JSON.parse(last));
    assert.equal(evidence.subject.local_path, target);
    const shapes = evidence.normalized_result.graph.nodes
      .flatMap((node) => node.observations)
      .map((observation) => observation.properties)
      .filter(
        (properties) =>
          properties.semantic_role === "export-return-shapes" &&
          properties.exported_name === "result",
      );
    assert(
      shapes.length > 0 &&
        shapes.every(
          (shape) => shape.return_shape_coverage?.projection_complete,
        ),
    );
    const fields = shapes.flatMap((shape) =>
      shape.static_return_shapes.flatMap((item) => item.fields),
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
    evidenceBytes = Buffer.byteLength(last);
    await writeFile(join(lab, "native-evidence.json"), last);
    evidenceSeen = true;
    finalSeen = true;
    return { role: "assistant", content: "REA_CLIENT_COMPATIBILITY_OK" };
  },
});
await writeFile(
  join(profile, "providers.json"),
  JSON.stringify({
    provider: {
      "rea-local": {
        baseURL: fixture.baseUrl,
        apiKey: false,
        models: {
          "rea-client-fixture": { contextWindow: 1_000_000, maxOutput: 4096 },
        },
      },
    },
  }),
);
const original =
  JSON.stringify(
    {
      mcpServers: { other: { command: "unrelated-server", enabled: false } },
      preserved: "keep unrelated settings",
    },
    null,
    2,
  ) + "\n";
await writeFile(configPath, original);
const rea = (args) =>
  exec(
    process.execPath,
    [join(runtimeRoot, "scripts/rea.mjs"), ...args, "--json"],
    { env: environment, cwd: workspace, timeout: 60_000 },
  );
try {
  clientVersion = (
    await exec(command, ["--version"], {
      env: environment,
      cwd: workspace,
      timeout: 30_000,
    })
  ).stdout.trim();
  for (const args of [
    ["setup", "--client", "commandcode", "--dry-run"],
    ["setup", "--client", "commandcode", "--yes"],
    ["doctor", "--client", "commandcode", "--skill"],
  ]) {
    const response = await rea(args);
    await writeFile(
      join(lab, `${args[0]}${args.includes("--dry-run") ? "-plan" : ""}.json`),
      response.stdout,
    );
    const result = JSON.parse(response.stdout);
    if (args[0] === "doctor") assert.equal(result.healthy, true);
    else
      assert.equal(
        result.status,
        args.includes("--dry-run") ? "planned" : "ready",
      );
    if (args.includes("--dry-run")) {
      assert(
        result.plannedActions.some((action) => action.target === configPath),
      );
      assert(
        result.plannedActions.every(
          (action) =>
            action.target === configPath ||
            action.target === skillDirectory ||
            action.target.startsWith(skillDirectory + "/"),
        ),
        "Refuse setup writes outside the disposable account's configuration and skill",
      );
    }
  }
  assert.equal(await readFile(`${configPath}.rea.backup`, "utf8"), original);
  const configured = await readFile(configPath, "utf8");
  assert.equal(JSON.parse(configured).preserved, "keep unrelated settings");
  assert.equal(
    JSON.parse(configured).mcpServers.other.command,
    "unrelated-server",
  );
  const repeated = JSON.parse(
    (await rea(["setup", "--client", "commandcode", "--yes"])).stdout,
  );
  assert.deepEqual(repeated.appliedActions, []);
  assert.equal(await readFile(configPath, "utf8"), configured);
  assert.equal(await readFile(`${configPath}.rea.backup`, "utf8"), original);
  expectedSkill = (await readFile(join(skillDirectory, "SKILL.md"), "utf8"))
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trim();
  const execution = exec(
    command,
    [
      "-p",
      mode === "chat"
        ? "Say hello briefly."
        : `Use the REA skill to analyze ${target}.`,
      "-m",
      "rea-local/rea-client-fixture",
      "--local-only",
      "--skip-onboarding",
      "--trust",
      "--output-format",
      "json",
      "--max-turns",
      "8",
      "--yolo",
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
  const events = response.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(
    events.some(
      (event) =>
        event.type === "result" &&
        event.subtype === "success" &&
        event.finalText === "REA_CLIENT_COMPATIBILITY_OK",
    ),
  );
  assert(inventoryChecked && finalSeen);
  if (mode === "call")
    assert(
      skillLoaded &&
        schemasChecked === expectedNames.length &&
        evidenceSeen &&
        (!catalogArtifact || artifactProjectionSeen),
    );
} catch (cause) {
  failure = cause;
  if (typeof cause?.stdout === "string")
    await writeFile(join(lab, `${mode}.stdout`), cause.stdout);
  if (typeof cause?.stderr === "string")
    await writeFile(join(lab, `${mode}.stderr`), cause.stderr);
} finally {
  await fixture.close();
  const receipt = {
    client: "Command Code",
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
      "loopback OpenAI completions/SSE, keyless BYOK, synthetic account-key gate and usage; no hosted authentication or live-model claim",
    discovery:
      "actual disposable OS account home; native user MCP configuration and default shared skill discovery; Windows unverified",
    interface:
      "default deferred schemas, complete exact-name search, native saved-catalog query when needed, actual JavaScript MCP call",
    inventoryChecked,
    catalogSize: inventoryChecked ? expectedNames.length : 0,
    schemasChecked,
    skillLoaded,
    catalogArtifact,
    catalogDigest,
    artifactProjectionSeen,
    evidenceSeen,
    evidenceBytes,
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
