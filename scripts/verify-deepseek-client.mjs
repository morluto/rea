import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import { pathExists } from "./lib/verify-package-core.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { bindVerifierCommandInterruption } from "./lib/verifier-command-interruption.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { publishClientReceipt } from "./verify/clients/receipt.mjs";
import { saveVerifierCommandOutput } from "./lib/verifier-command-output.mjs";
import {
  CLIENT_JAVASCRIPT_FIXTURE_SOURCE,
  assertClientJavaScriptFixtureEvidence,
} from "./verify/clients/javascript-fixture.mjs";
import {
  findClientResult,
  isClientJavaScriptEvidence,
} from "./verify/clients/result-discovery.mjs";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";
import {
  hasDeepSeekFinalEvent,
  hasDeepSeekSkillBody,
} from "./verify/clients/deepseek-evidence.mjs";
import {
  createOpenAiModelFixture,
  toolCallMessage,
} from "./verify/clients/model-fixture.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";

const expectedFinal = "REA_CLIENT_COMPATIBILITY_OK";

const mode = process.argv[2] ?? "call";
assert(["chat", "call"].includes(mode), "Select chat or call.");
assert(process.platform !== "win32", "Native Windows coverage is unverified.");
const { assertClientSchemaPatterns } = await importVerifierSource(
  new URL("./lib/client-schema-patterns.mts", import.meta.url).href,
  import.meta.url,
);

const repo = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.REA_VERIFY_RUNTIME_ROOT ?? repo;
const command = process.env.REA_VERIFY_DEEPSEEK_COMMAND ?? "dsh";
const { path: lab } = await VerifierFixture.keepArtifacts({
  prefix: "rea-deepseek-client-",
});
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
const configPath = join(profile, "cordis.patch.yml");
const verifier = createVerifierRun();
let clientVersion = null;
let fixture;
let passed = false;
let catalog;
let patternCount = 0;
let skillRequested = false;
let skillLoaded = false;
let expectedSkillBody;
let evidenceSeen = false;
let finalSeen = false;
let clientFinalSeen = false;
let artifactDigest;
let mainRequests = 0;
const lifecycle = [];
const patterns = new Set();
const commandOwner = await createVerifierCommands();
const commands = bindVerifierCommandInterruption(commandOwner);
await withVerifierCleanup(async () => {
  await withVerifierCleanup(async () => {
    await Promise.all([
      mkdir(account),
      mkdir(profile),
      mkdir(target, { recursive: true }),
    ]);
    const environment = {
      PATH: process.env.PATH ?? "",
      HOME: account,
      USERPROFILE: account,
      DSH_HOME: profile,
      OPENAI_API_KEY: "local-fixture-key",
      REA_PROCESS_RUN_ID: verifier.run_id,
    };
    // A temporary directory under the checkout must not inherit its project skills or AGENTS.md.
    await commands.exec(
      "git",
      ["-c", "init.defaultBranch=main", "init", "--quiet", workspace],
      {
        env: environment,
        timeout: 30_000,
        stdin: "pipe",
      },
    );
    await writeFile(join(target, "app.js"), CLIENT_JAVASCRIPT_FIXTURE_SOURCE);
    clientVersion = (
      await commands.exec(command, ["--version"], {
        env: environment,
        cwd: workspace,
        timeout: 30_000,
        stdin: "pipe",
      })
    ).stdout.trim();
    const runRea = async (args, artifact) => {
      const result = await commands.exec(
        process.execPath,
        [cli, ...args, "--json"],
        {
          env: environment,
          cwd: workspace,
          timeout: 60_000,
          stdin: "pipe",
        },
      );
      await writeFile(join(lab, `${artifact}.json`), result.stdout);
      return JSON.parse(result.stdout);
    };
    const patches = (text) =>
      parseYaml(text, {
        customTags: [
          {
            tag: "tag:yaml.org,2002:js",
            resolve: (source) => ({ __jsExpr: source }),
          },
        ],
      });
    const withoutRea = (text) =>
      patches(text).flatMap((op) => {
        if (op.id === "rea-mcp") return [];
        if (!Array.isArray(op.insert)) return [op];
        const insert = op.insert.filter((entry) => entry.id !== "rea-mcp");
        return insert.length === 0 ? [] : [{ ...op, insert }];
      });

    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    fixture = await createOpenAiModelFixture({
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
            const forwardedPatterns = assertClientSchemaPatterns(
              tool.parameters,
            );
            for (const pattern of forwardedPatterns) patterns.add(pattern);
            patternCount += forwardedPatterns.length;
          }
          assert(
            patternCount > 0,
            "The advertised regex constraints must reach the model.",
          );
        }
        const toolMessages = (body.messages ?? []).filter(
          (message) => message.role === "tool",
        );
        skillLoaded ||=
          expectedSkillBody !== undefined &&
          hasDeepSeekSkillBody(
            toolMessages,
            dirname(skillPath),
            expectedSkillBody,
          );
        for (const message of toolMessages) {
          const found = findClientResult(
            message.content,
            isClientJavaScriptEvidence,
          );
          if (found === undefined) continue;
          const { evidence } = await assertClientJavaScriptFixtureEvidence(
            found,
            target,
          );
          const text = JSON.stringify(evidence);
          await writeFile(join(lab, "evidence.json"), text);
          artifactDigest = createHash("sha256").update(text).digest("hex");
          evidenceSeen = true;
        }
        if (mode === "chat" || evidenceSeen) {
          finalSeen = true;
          return { role: "assistant", content: expectedFinal };
        }
        const call = (name, args) =>
          toolCallMessage(`call_rea_${requestIndex}`, name, args);
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
    // Seed model settings and a stale registration; the public setup workflow
    // must produce the registration this native client actually boots.
    const original = `
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
        command: stale-launcher
        args: [mcp]
        cwd: !!js process.cwd()
        env:
          REA_PROCESS_RUN_ID: ${JSON.stringify(verifier.run_id)}
`;
    await writeFile(configPath, original);
    const planned = await runRea(
      ["setup", "--client", "dsh", "--dry-run"],
      "setup-plan",
    );
    assert.equal(planned.status, "planned");
    assert(
      planned.plannedActions.some((action) => action.target === configPath),
    );
    assert(
      planned.plannedActions.some(
        (action) => action.target === dirname(skillPath),
      ),
    );
    assert(
      planned.plannedActions.every(
        (action) =>
          action.target === configPath || action.target === dirname(skillPath),
      ),
    );
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal(await pathExists(`${configPath}.rea.backup`), false);
    lifecycle.push("dry-run");
    const setup = await runRea(["setup", "--client", "dsh", "--yes"], "setup");
    assert.equal(setup.status, "ready");
    assert.equal(await readFile(`${configPath}.rea.backup`, "utf8"), original);
    const configured = await readFile(configPath, "utf8");
    assert.deepEqual(withoutRea(configured), withoutRea(original));
    assert(configured.includes("!!js process.cwd()"));
    const installedSkill = await readFile(skillPath, "utf8");
    assert(installedSkill.includes("name: reverse-engineer-anything"));
    const frontmatter = /^---\r?\n[\s\S]*?^---(?:\r?\n|$)/mu.exec(
      installedSkill,
    );
    assert(frontmatter, "Installed skill must have its authored frontmatter");
    expectedSkillBody = installedSkill.slice(frontmatter[0].length).trim();
    assert(expectedSkillBody.length > 0);

    lifecycle.push("setup");
    const repeated = await runRea(
      ["setup", "--client", "dsh", "--yes"],
      "setup-repeat",
    );
    assert.deepEqual(repeated.appliedActions, []);
    assert.equal(await readFile(configPath, "utf8"), configured);
    assert.equal(await readFile(`${configPath}.rea.backup`, "utf8"), original);
    lifecycle.push("idempotent-setup");
    const doctor = await runRea(
      ["doctor", "--client", "dsh", "--skill"],
      "doctor",
    );
    assert.equal(doctor.healthy, true);
    lifecycle.push("doctor");
    await saveVerifierCommandOutput(
      async () => {
        const result = await commands
          .exec(
            command,
            [
              "--profile",
              "headless",
              "--json",
              mode === "chat"
                ? "Say hello briefly."
                : `Use REA to analyze ${target}.`,
            ],
            {
              env: environment,
              cwd: workspace,
              timeout: 120_000,
              stdin: "closed-pipe",
              maxBuffer: 10 * 1024 * 1024,
            },
          )
          .catch((cause) => {
            const stdout = cause?.snapshot?.stdout;
            if (stdout !== undefined && stdout.bytes === stdout.observedBytes)
              clientFinalSeen = hasDeepSeekFinalEvent(
                stdout.text,
                expectedFinal,
              );
            throw cause;
          });
        clientFinalSeen = hasDeepSeekFinalEvent(result.stdout, expectedFinal);
        return result;
      },
      {
        stdout: join(lab, "client.stdout"),
        stderr: join(lab, "client.stderr"),
      },
    );
    assert.equal(fixture.failure, undefined);
    assert(finalSeen, "The loopback model did not supply the expected answer");
    assert(
      clientFinalSeen,
      "Harness did not emit the expected terminal final event",
    );
    if (mode === "call") assert(evidenceSeen && skillLoaded);
    lifecycle.push(mode === "call" ? "native-tool-invocation" : "native-chat");
    const uninstall = await runRea(["uninstall"], "uninstall");
    assert.equal(uninstall.status, "complete");
    assert(
      uninstall.items.some(
        (item) => item.name === "dsh" && item.status === "removed",
      ),
    );
    assert.deepEqual(
      patches(await readFile(configPath, "utf8")),
      withoutRea(original),
    );
    assert.equal(await pathExists(skillPath), false);
    lifecycle.push("uninstall");
  }, [
    () => commandOwner.close(),
    async () => {
      await fixture?.close();
    },
  ]);
  commands.throwIfInterrupted();
  passed = true;
}, [
  async () => {
    const completed = await completeVerifierRun(verifier);
    const reason = commands.finish();
    const receipt = {
      client: "deepseek-harness",
      clientVersion,
      mode,
      lifecycle,
      passed: passed && reason === undefined,
      interruption: reason?.message,
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
        "native HOME shared personal directory; isolated project root",
      catalogSize: catalog?.length,
      patternCount,
      uniquePatterns: patterns.size,
      skillLoaded,
      evidenceSeen,
      artifactDigest,
      finalSeen,
      clientFinalSeen,
      requests: fixture?.requests,
      fixtureFailure: fixture?.failure,
      verifier: completed,
    };
    await withVerifierCleanup(() => {
      if (!receipt.passed) return;
      try {
        assertVerifierCleanupComplete(receipt.verifier.process_lineage);
      } catch (cause) {
        receipt.passed = false;
        throw cause;
      }
    }, [() => publishClientReceipt(lab, receipt)]);
  },
  () => {
    const reason = commands.finish();
    if (passed && reason !== undefined) throw reason;
  },
]);
