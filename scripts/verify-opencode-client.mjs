import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import { currentClientRegistrationCommand } from "../dist/application/ClientRegistrationIdentity.js";
import { isPathWithinRoot } from "../dist/domain/localPath.js";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { saveVerifierCommandOutput } from "./lib/verifier-command-output.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import {
  CLIENT_JAVASCRIPT_FIXTURE_SOURCE,
  assertClientJavaScriptFixtureEvidence,
} from "./verify/clients/javascript-fixture.mjs";
import {
  findClientResult,
  isClientJavaScriptEvidence,
} from "./verify/clients/result-discovery.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { createOpenAiModelFixture } from "./verify/clients/model-fixture.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.REA_VERIFY_RUNTIME_ROOT ?? repo;
const command = process.env.REA_VERIFY_OPENCODE_COMMAND ?? "opencode";
const mode = process.argv[2] ?? "call";
const configFormat = process.env.REA_VERIFY_OPENCODE_CONFIG_FORMAT ?? "jsonc";
const dialect = process.env.REA_VERIFY_OPENCODE_DIALECT ?? "v2";
assert(
  ["chat", "call"].includes(mode),
  "Usage: verify-opencode-client.mjs [chat|call]",
);
assert(
  ["json", "jsonc"].includes(configFormat),
  "REA_VERIFY_OPENCODE_CONFIG_FORMAT must be json or jsonc",
);
assert(
  ["v1", "v2"].includes(dialect),
  "REA_VERIFY_OPENCODE_DIALECT must be v1 or v2",
);
const verifier = createVerifierRun();
// The advertised catalog belongs to the runtime under test. A checkout can run
// ahead of the published package, so this checkout's own contracts would not
// describe the server the client actually started.
const toolContracts =
  runtimeRoot === repo
    ? TOOL_CONTRACTS
    : (
        await import(
          pathToFileURL(
            join(runtimeRoot, "dist", "contracts", "toolContracts.js"),
          ).href
        )
      ).TOOL_CONTRACTS;
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
assert.equal(
  isPathWithinRoot(skillDirectory, `${skillDirectory}-sibling/AGENTS.md`),
  false,
);
assert.equal(
  isPathWithinRoot(
    skillDirectory,
    join(skillDirectory, "..", "outside", "AGENTS.md"),
  ),
  false,
);
let clientVersion = null;
let fixture;
let passed = false;
let skillRequested = false;
let skillLoaded = false;
let expectedSkillBody;
let evidenceSeen = false;
let finalSeen = false;
let catalogSize = null;
let schemasChecked = 0;
let artifactDigest;
const commands = await createVerifierCommands();
await withVerifierCleanup(async () => {
  await withVerifierCleanup(async () => {
    await Promise.all([mkdir(account), mkdir(profile), mkdir(workspace)]);
    await commands.exec("git", ["init", "--quiet", workspace], {
      timeout: 30_000,
      stdin: "pipe",
    });
    const environment = {
      // A closed environment without PATH cannot start a client on either
      // platform, so the host environment is inherited and the client's own
      // directories are redirected into the lab. Clear caller OpenCode
      // configuration overrides so an inherited OPENCODE_CONFIG path or
      // OPENCODE_CONFIG_CONTENT payload cannot join the lab's selected layers.
      // Pin an unscoped, full REA catalog so inherited REA_MCP_TOOL_FAMILIES
      // or REA_MCP_TOOL_CATALOG_PROFILE=hot-cold cannot hide analysis tools
      // the fixture requires on the first model request.
      ...process.env,
      HOME: account,
      USERPROFILE: account,
      OPENCODE_CONFIG: undefined,
      OPENCODE_CONFIG_CONTENT: undefined,
      OPENCODE_CONFIG_DIR: profile,
      XDG_CONFIG_HOME: join(lab, "config"),
      XDG_CACHE_HOME: join(lab, "cache"),
      XDG_DATA_HOME: join(lab, "data"),
      XDG_STATE_HOME: join(lab, "state"),
      APPDATA: join(lab, "appdata", "roaming"),
      LOCALAPPDATA: join(lab, "appdata", "local"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      // OpenCode V1 isolates its native core from account plugins with this
      // variable. OpenCode V2 dropped it, so V2 isolates external plugin
      // packages through the `plugins` configuration and the redirected
      // configuration directory instead.
      ...(dialect === "v1" ? { OPENCODE_PURE: "true" } : {}),
      REA_MCP_TOOL_FAMILIES: undefined,
      REA_MCP_TOOL_CATALOG_PROFILE: "full",
      REA_PROCESS_RUN_ID: verifier.run_id,
    };
    try {
      clientVersion = (
        await commands.exec(command, ["--version"], {
          env: environment,
          timeout: 30_000,
          stdin: "pipe",
        })
      ).stdout.trim();
    } catch (cause) {
      // npm installs put only an opencode.cmd shim on PATH; cross-spawn runs
      // that shim, and a desktop installation ships a real executable.
      const windowsHint =
        process.platform === "win32"
          ? " On Windows, select the opencode executable, for example the npm package's node_modules/opencode-ai/bin/opencode.exe."
          : "";
      throw new Error(
        `OpenCode preflight failed for ${command}; install OpenCode or set REA_VERIFY_OPENCODE_COMMAND.${windowsHint} ${String(cause)}`,
        { cause },
      );
    }
    const target = join(lab, "fixture α测试");
    await mkdir(target);
    await writeFile(join(target, "app.js"), CLIENT_JAVASCRIPT_FIXTURE_SOURCE);
    const schemaValidator = new Ajv2020({
      strict: false,
      validateFormats: false,
    });
    fixture = await createOpenAiModelFixture({
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
        const expected = toolContracts.map((t) => prefix + t.name).sort();
        const reaTools = tools.filter((t) => expected.includes(t.name));
        catalogSize = reaTools.length;
        assert.deepEqual(
          reaTools.map((t) => t.name).sort(),
          expected,
          "OpenCode must forward the complete REA catalog",
        );
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
        const observed = findClientResult(replies, isClientJavaScriptEvidence);
        if (observed) {
          const { evidence } = await assertClientJavaScriptFixtureEvidence(
            observed,
            target,
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
        assert(
          requestIndex <= 8,
          "Local model workflow exceeded its turn budget",
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
        if (!skillRequested) {
          const skill = tools.find((t) => t.name === "skill");
          assert(skill, "OpenCode must expose its native skill tool");
          skillRequested = true;
          // OpenCode V2 names the skill argument `id`; V1 accepted `name`.
          return call(skill.name, {
            [dialect === "v1" ? "name" : "id"]: "reverse-engineer-anything",
          });
        }
        assert(
          skillLoaded,
          "OpenCode must load the installed personal REA skill",
        );
        return call(analysis.name, { input_path: target, format: "directory" });
      },
    });
    // The registration REA's setup writes is the same launcher it selects for
    // itself. Seeding it keeps the lane on REA's own refresh path and proves
    // that a client-owned server option survives that refresh.
    const reaLauncher = currentClientRegistrationCommand({
      entrypointPath: join(runtimeRoot, "scripts/rea.mjs"),
      environment,
      platform: process.platform,
    });
    assert.equal(
      reaLauncher.length,
      3,
      "REA must resolve a runtime, entry script and mcp argument",
    );
    // OpenCode V2 groups MCP tools behind its Code Mode tool by default. The
    // lane observes the forwarded catalog as direct function tools, which is
    // OpenCode's documented `codemode: false` option.
    const reaServer = {
      type: "local",
      command: [...reaLauncher],
      ...(dialect === "v2" ? { codemode: false } : {}),
    };
    const unrelatedServer = {
      type: "local",
      command: ["unrelated-server"],
      ...(dialect === "v2" ? { disabled: true } : { enabled: false }),
    };
    const original =
      (configFormat === "jsonc" ? "// Keep caller configuration.\n" : "") +
      JSON.stringify(
        {
          autoupdate: false,
          // OpenCode V2 reads additional skill sources as an array.
          skills:
            dialect === "v1"
              ? { paths: [join(account, ".agents", "skills")] }
              : [join(account, ".agents", "skills")],
          // OpenCode V2 replaced the V1 permission map with ordered rules.
          ...(dialect === "v1"
            ? { permission: { "*": "allow" } }
            : {
                permissions: [{ action: "*", resource: "*", effect: "allow" }],
              }),
          // No external plugin package may join the verified run.
          plugins: [],
          provider: {
            "rea-fixture": {
              npm: "@ai-sdk/openai-compatible",
              name: "REA local model fixture",
              options: {
                baseURL: fixture.baseUrl,
                apiKey: "local-fixture-key",
              },
              models: {
                "rea-client-fixture": {
                  name: "REA fixture",
                  tool_call: true,
                  limit: { context: 1_000_000, output: 4096 },
                },
              },
            },
          },
          // OpenCode V2 keeps server names under `mcp.servers`; the V1 table
          // placed them directly under `mcp`.
          mcp:
            dialect === "v2"
              ? { servers: { other: unrelatedServer, rea: reaServer } }
              : { other: unrelatedServer, rea: reaServer },
        },
        null,
        2,
      );
    await writeFile(configPath, original);
    for (const args of [
      ["setup", "--client", "opencode", "--dry-run"],
      ["setup", "--client", "opencode", "--yes"],
      ["doctor", "--client", "opencode", "--skill"],
    ]) {
      const result = await commands.exec(
        process.execPath,
        [join(runtimeRoot, "scripts/rea.mjs"), ...args, "--json"],
        { env: environment, cwd: workspace, timeout: 60_000, stdin: "pipe" },
      );
      await writeFile(
        join(
          lab,
          `${args[0]}${args.includes("--dry-run") ? "-plan" : ""}.json`,
        ),
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
          assert(
            parsed.plannedActions.some((a) => a.target === skillDirectory),
          );
          assert(
            parsed.plannedActions.every(
              (a) =>
                a.target === configPath ||
                (isAbsolute(a.target) &&
                  isPathWithinRoot(skillDirectory, a.target)),
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
    const repeated = await commands.exec(
      process.execPath,
      [
        join(runtimeRoot, "scripts/rea.mjs"),
        "setup",
        "--client",
        "opencode",
        "--yes",
        "--json",
      ],
      { env: environment, cwd: workspace, timeout: 60_000, stdin: "pipe" },
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
    const response = await saveVerifierCommandOutput(
      () =>
        commands.exec(
          command,
          [
            "run",
            "--format",
            "json",
            // The shared background service keeps the environment it started
            // with, so it would ignore this lane's isolated configuration
            // directory. A private server reads the redirected one.
            ...(dialect === "v2" ? ["--standalone"] : []),
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
            stdin: "closed-pipe",
          },
        ),
      {
        stdout: join(lab, `${mode}.stdout`),
        stderr: join(lab, `${mode}.stderr`),
      },
    );
    assert.equal(fixture.failure, undefined);
    assert(
      finalSeen && response.stdout.includes("REA_CLIENT_COMPATIBILITY_OK"),
    );
    if (mode === "call") assert(evidenceSeen && skillLoaded);
  }, [
    () => commands.close(),
    async () => {
      await fixture?.close();
    },
  ]);
  passed = true;
}, [
  async () => {
    const lineage = await completeVerifierRun(verifier);
    const receipt = {
      client: "OpenCode",
      clientVersion,
      mode,
      configFormat,
      dialect,
      passed,
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
      externalPlugins:
        dialect === "v1"
          ? "disabled through native OPENCODE_PURE"
          : "disabled through the OpenCode V2 plugins configuration and a redirected configuration directory without a plugin directory",
      mcpToolSurface:
        dialect === "v2"
          ? "direct function tools through the OpenCode V2 codemode:false server option"
          : "direct function tools",
      catalogSize,
      schemasChecked,
      evidenceSeen,
      skillLoaded,
      artifactDigest,
      finalSeen,
      requests: fixture?.requests,
      probes: fixture?.probes,
      fixtureFailure: fixture?.failure,
      verifier: lineage,
    };
    await withVerifierCleanup(
      () =>
        writeFile(join(lab, "receipt.json"), JSON.stringify(receipt, null, 2)),
      [
        () => {
          console.log(JSON.stringify(receipt));
        },
      ],
    );
  },
]);
