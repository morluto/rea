import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { createTestProcessRegistry } from "../../tests/support/process/processFixture.js";
import { resolveMcpRegistrationClientId } from "./McpRegistrationCatalog.js";

it.each([
  ["cline-vscode", "cline"],
  ["codeium", "windsurf"],
  ["cascade", "windsurf"],
  ["droid", "factory-droid"],
  ["factory", "factory-droid"],
  ["gemini", "gemini-cli"],
  ["github-copilot", "vscode"],
  ["grok", "grok-build"],
  ["hermes-agent", "hermes"],
  ["kilo", "kilo-code"],
  ["kilocode", "kilo-code"],
  ["kimi", "kimi-code"],
  ["kiro", "kiro-cli"],
  ["mastra", "mastracode"],
  ["pi-agent", "pi"],
])("retains helper alias %s as %s", (alias, expected) => {
  expect(resolveMcpRegistrationClientId(alias.toUpperCase())).toBe(expected);
});

it("does not treat prototype names or unknown strings as client identities", () => {
  expect(resolveMcpRegistrationClientId("__proto__")).toBeUndefined();
  expect(resolveMcpRegistrationClientId("constructor")).toBeUndefined();
  expect(resolveMcpRegistrationClientId("unknown-client")).toBeUndefined();
});

const clientSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  configPath: z.string(),
  configPaths: z.array(z.string()).optional(),
  scope: z.enum(["global", "project"]),
  format: z.string(),
  privateProfile: z.literal(true).optional(),
  inlineConfiguration: z
    .object({ origin: z.literal("KILO_CONFIG_CONTENT"), parsed: z.unknown() })
    .optional(),
});
const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.array(clientSchema) }),
  z.object({
    ok: z.literal(false),
    error: z.object({ tag: z.string(), message: z.string() }),
  }),
]);

const catalogObservationsSchema = z.object({
  empty: resultSchema,
  layeredKilo: resultSchema,
  layeredOpenCode: resultSchema,
  explicit: resultSchema,
  detected: resultSchema,
  project: resultSchema,
  onlyGlobal: resultSchema,
  defaultProject: resultSchema,
  projectAmp: resultSchema,
  unknown: resultSchema,
  blockedCandidate: resultSchema.nullable(),
  unknownDetection: resultSchema,
  cancelled: resultSchema,
  ancestorLayers: resultSchema.nullable(),
  selectedLayers: resultSchema,
  projectReadonly: resultSchema.nullable(),
  noRepository: resultSchema.nullable(),
  disabled: resultSchema.nullable(),
  invalidInline: resultSchema,
  invalidGit: resultSchema.nullable(),
  unterminatedGit: resultSchema.nullable(),
  linkedWorktree: resultSchema.nullable(),
  missingTarget: resultSchema.nullable(),
  cancelledGit: resultSchema.nullable(),
  repeatedFile: resultSchema,
  repeatedDirectory: resultSchema,
  whitespaceWorktree: resultSchema.nullable(),
});

const FAKE_GIT_PROGRAM = String.raw`const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.REA_TEST_GIT_STATE,"utf8"));
fs.appendFileSync(process.env.REA_TEST_GIT_CALLS,JSON.stringify(process.argv.slice(2))+"\n");
if (state.invalid) process.stdout.write(Buffer.from([255,10]));
else if (state.unterminated) process.stdout.write(state.root);
else if (state.hang) { fs.writeFileSync(state.hang,"ready"); setInterval(()=>{},1000); }
else {
 const key=process.argv[3];
 process.stdout.write(key==="--show-toplevel"?state.root+"\n":key==="--git-dir"?state.git+"\n":key==="--git-common-dir"?state.common+"\n":"worktree "+state.primary+"\0HEAD inert\0\0");
}
`;

const CATALOG_PROGRAM = `
      import { homedir } from 'node:os';
      import { join, relative, isAbsolute, delimiter } from 'node:path';
      import { mkdir, writeFile, rm, realpath, readFile, lstat } from 'node:fs/promises';
      const home = process.env.HOME;
      if (!home || await realpath(home) !== await realpath(homedir())) throw Error('Fixture HOME not selected before catalog import.');
      for (const key of ['USERPROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','APPDATA','LOCALAPPDATA']) {
        const path = relative(home, process.env[key]);
        if (path.startsWith('..') || isAbsolute(path)) throw Error('Fixture location escaped: ' + key);
      }
      const { resolveMcpRegistrationClients } = await import(${JSON.stringify(new URL("./McpRegistrationCatalog.ts", import.meta.url).href)});
      const { ArtifactResourceScope } = await import(${JSON.stringify(new URL("../artifacts/ArtifactResourceScope.ts", import.meta.url).href)});
      const resources = new ArtifactResourceScope();
      try {
      const posix = process.platform !== 'win32';
      const cwd = join(home, 'project');
      await mkdir(cwd);
      const selection = { agents: [], global: true, home, cwd, platform: process.platform, environment: process.env };
      const observe = async (changes = {}) => {
        const result = await resources.run(() => resolveMcpRegistrationClients({ ...selection, ...changes }, resources));
        if (!result.ok) return { ok: false, error: { tag: result.error._tag, message: result.error.message } };
        for (const client of result.value) for (const source of [client.configPath,...client.configPaths ?? []]) {
          const path = relative(home, source);
          if (path.startsWith('..') || isAbsolute(path)) throw Error('Catalog path escaped temporary HOME: ' + client.id);
        }
        return result;
      };
      // Only the authored POSIX Git executable and newline-path controls are omitted on Windows.
      const observeProject = changes => posix ? observe({agents:['kilo'],global:false,...changes}) : null;
      const empty = await observe();
      const layeredRoot = join(home, 'layered', 'kilo');
      await mkdir(layeredRoot, { recursive: true });
      for (const name of ['config.json','kilo.json','kilo.jsonc','opencode.json','opencode.jsonc']) await writeFile(join(layeredRoot,name),'{}');
      const layeredKilo = await observe({ agents:['kilo'], environment:{...process.env,XDG_CONFIG_HOME:join(home,'layered')} });
      const layeredOpenCode = await observe({ agents:['opencode'] });
      const customCodex = join(home, 'selected-codex');
      const explicit = await observe({ agents: ['CODEX','Amp','gemini','fx','codeium','windsurf'], environment: { ...process.env, CODEX_HOME: customCodex } });
      await mkdir(join(home, '.claude'));
      await mkdir(join(home, '.cursor'));
      const detected = await observe();
      const gitBin = join(home, 'git-bin');
      await mkdir(gitBin);
      const gitState = join(home, 'git-state.json');
      const gitCalls = join(home, 'git-calls.jsonl');
      await mkdir(join(cwd, '.git'));
      const gitProgram = ${JSON.stringify("#!" + process.execPath + "\n" + FAKE_GIT_PROGRAM)};
      await writeFile(join(gitBin,'git'),gitProgram,{mode:0o755});
      const gitEnvironment = {...process.env, PATH:gitBin+delimiter+process.env.PATH, REA_TEST_GIT_STATE:gitState, REA_TEST_GIT_CALLS:gitCalls};
      const state = {root:cwd,git:join(cwd,'.git'),common:join(cwd,'.git')};
      await writeFile(gitState,JSON.stringify(state));
      selection.environment = gitEnvironment;
      await mkdir(join(cwd, '.github'));
      await writeFile(join(cwd, '.github', 'mcp.json'), '{}');
      await mkdir(join(cwd, '.kilocode'));
      await writeFile(join(cwd, '.kilocode', 'kilo.jsonc'), '{}');
      const project = await observe({ agents: ['github-copilot-cli',...(posix?['kilo']:[]),'opencode'], global: false });
      const nested = join(cwd,'nested');
      await mkdir(join(nested,'.kilocode'),{recursive:true});
      await writeFile(join(cwd,'kilo.json'),'{}');
      await writeFile(join(nested,'kilo.jsonc'),'{}');
      await writeFile(join(cwd,'opencode.json'),'{}');
      await writeFile(join(nested,'opencode.jsonc'),'{}');
      await writeFile(join(nested,'.kilocode','kilo.jsonc'),'{}');
      const ancestorLayers = await observeProject({cwd:nested});
      const overrideFile = join(home,'override.json');
      const overrideDirectory = join(home,'override-dir');
      await writeFile(overrideFile,'{}');
      await mkdir(overrideDirectory);
      await writeFile(join(overrideDirectory,'kilo.jsonc'),'{}');
      await writeFile(join(overrideDirectory,'opencode.json'),'{}');
      const selectedLayers = await observe({agents:['kilo'],environment:{...gitEnvironment,KILO_CONFIG:overrideFile,KILO_CONFIG_DIR:overrideDirectory,KILO_CONFIG_CONTENT:'{"metadata":"selected","mcp":{"peer":{"type":"local","command":["peer"]}}}'}});
      const projectReadonly = await observeProject({cwd:nested,environment:{...gitEnvironment,KILO_CONFIG:overrideFile,KILO_CONFIG_DIR:overrideDirectory,KILO_CONFIG_CONTENT:'{"metadata":"readonly"}'}});
      const noRepository = await observeProject({cwd:home});
      const disabled = await observeProject({environment:{...gitEnvironment,KILO_DISABLE_PROJECT_CONFIG:'true'}});
      const invalidInline = await observe({agents:['kilo'],environment:{...gitEnvironment,KILO_CONFIG_CONTENT:'{'}});
      await writeFile(gitState,JSON.stringify({...state,invalid:true}));
      const invalidGit = await observeProject({});
      await writeFile(gitState,JSON.stringify({...state,unterminated:true}));
      const unterminatedGit = await observeProject({});
      const primary = join(home,'primary');
      await mkdir(join(primary,'.git'),{recursive:true});
      await mkdir(join(primary,'nested','.kilo'),{recursive:true});
      await writeFile(join(primary,'nested','.kilo','opencode.json'),'{}');
      await writeFile(gitState,JSON.stringify({...state,common:join(primary,'.git'),primary}));
      const linkedWorktree = await observeProject({cwd:nested});
      await writeFile(gitState,JSON.stringify(state));
      const emptyRoot = join(home,'empty-worktree');
      await mkdir(join(emptyRoot,'.git'),{recursive:true});
      await writeFile(gitState,JSON.stringify({root:emptyRoot,git:join(emptyRoot,'.git'),common:join(emptyRoot,'.git')}));
      const missingTarget = await observeProject({cwd:emptyRoot,environment:{...gitEnvironment,KILO_CONFIG_DIR:overrideDirectory}});
      let cancelledGit = null;
      if(posix) {
      const ready = join(home,'git-ready');
      await writeFile(gitState,JSON.stringify({...state,hang:ready}));
      const duringGit = new AbortController();
      const cancellation = observeProject({signal:duringGit.signal});
      try {
        const end = Date.now()+3000;
        while(true) { try { await lstat(ready); break; } catch(error) { if(error.code!=='ENOENT')throw error; } if(Date.now()>=end)throw Error('Inert Git did not become ready');await new Promise(resolve=>setTimeout(resolve,10)); }
      } finally { duringGit.abort({fixture:'during-readonly-git'}); }
      cancelledGit = await cancellation;
      await writeFile(gitState,JSON.stringify(state));
      const gitQueries = (await readFile(gitCalls,'utf8')).trimEnd().split('\\n').map(line=>JSON.parse(line));
      for(const args of gitQueries)if(![['rev-parse','--show-toplevel'],['rev-parse','--git-dir'],['rev-parse','--git-common-dir'],['worktree','list','--porcelain','-z']].some(expected=>JSON.stringify(expected)===JSON.stringify(args)))throw Error('Unexpected Git command');
      }
      let whitespaceWorktree = null;
      if(posix) {
      const whitespaceRoot = join(home,' worktree'+String.fromCharCode(10)+'with-space ');
      await mkdir(join(whitespaceRoot,'.git'),{recursive:true});
      await writeFile(gitState,JSON.stringify({root:whitespaceRoot,git:join(whitespaceRoot,'.git'),common:join(whitespaceRoot,'.git')}));
      whitespaceWorktree = await observeProject({cwd:whitespaceRoot});
      await writeFile(gitState,JSON.stringify(state));
      }
      const repeatedFile = await observe({agents:['kilo'],environment:{...gitEnvironment,XDG_CONFIG_HOME:join(home,'layered'),KILO_CONFIG:join(layeredRoot,'kilo.json')}});
      await mkdir(join(home,'.kilocode'));
      await mkdir(join(home,'.kilo'));
      await writeFile(join(home,'.kilo','opencode.json'),'{}');
      const repeatedDirectory = await observe({agents:['kilo'],environment:{...gitEnvironment,KILO_CONFIG_DIR:join(home,'.kilocode')}});
      const onlyGlobal = await observe({ agents: ['cursor','goose'], global: false });
      const defaultProject = await observe({ global: false });
      const projectAmp = await observe({ agents: ['amp'], global: false });
      const unknown = await observe({ agents: ['unknown-client'] });
      await writeFile(join(cwd, '.kilo'), 'blocks candidate directory');
      const blockedCandidate = await observeProject({});
      await writeFile(join(home, '.cline'), 'blocks detection directory');
      const unknownDetection = await observe();
      const controller = new AbortController(); controller.abort({ fixture: 'cancel' });
      const cancelled = await observe({ agents: ['amp'], signal: controller.signal });
      console.log(JSON.stringify({ empty, layeredKilo, layeredOpenCode, explicit, detected, project, onlyGlobal, defaultProject, projectAmp, unknown, blockedCandidate, unknownDetection, cancelled, ancestorLayers, selectedLayers, projectReadonly, noRepository, disabled, invalidInline, invalidGit, unterminatedGit, linkedWorktree, missingTarget, cancelledGit, repeatedFile, repeatedDirectory, whitespaceWorktree }));
      } finally { await resources.close(); if(resources.hasPending) throw Error("Git cleanup remained owned."); }
    `;

const REVIEWED_CLIENT_IDS = [
  "antigravity",
  "cline",
  "cline-cli",
  "claude-code",
  "claude-desktop",
  "codex",
  "cursor",
  "factory-droid",
  "fx",
  "gemini-cli",
  "goose",
  "github-copilot-cli",
  "grok-build",
  "hermes",
  "junie",
  "kilo-code",
  "kimi-code",
  "kiro-cli",
  "mastracode",
  "mcporter",
  "opencode",
  "pi",
  "vscode",
  "windsurf",
  "zed",
  "amp",
];

it("resolves selected-environment paths and scopes without external catalog readers", async () => {
  const home = await createTestTempDirectory("rea-registration-catalog-");
  const processes = createTestProcessRegistry();
  try {
    await mkdir(join(home, "config"));
    const child = await processes.run(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", CATALOG_PROGRAM],
      {
        timeoutMs: 50_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TMPDIR: process.env.TMPDIR,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
          XDG_STATE_HOME: join(home, "state"),
          APPDATA: join(home, "appdata"),
          LOCALAPPDATA: join(home, "localappdata"),
        },
      },
    );
    expect(child.exitCode, child.stderr).toBe(0);
    const result = catalogObservationsSchema.parse(JSON.parse(child.stdout));
    assertKiloNativeLayers(result, home);
    expect(result.empty.ok).toBe(true);
    if (!result.empty.ok) throw new Error(result.empty.error.message);
    expect(result.empty.value.map((client) => client.id)).toEqual(
      REVIEWED_CLIENT_IDS,
    );
    expect(result.layeredKilo.ok).toBe(true);
    if (!result.layeredKilo.ok)
      throw new Error(result.layeredKilo.error.message);
    const kiloLayers = [
      "config.json",
      "kilo.json",
      "kilo.jsonc",
      "opencode.json",
      "opencode.jsonc",
    ].map((name) => join(home, "layered", "kilo", name));
    expect(result.layeredKilo.value[0]).toMatchObject({
      configPath: kiloLayers.at(-1),
      configPaths: kiloLayers,
    });
    expect(result.layeredOpenCode.ok).toBe(true);
    if (!result.layeredOpenCode.ok)
      throw new Error(result.layeredOpenCode.error.message);
    expect(result.layeredOpenCode.value[0]?.configPaths).toEqual(
      ["config.json", "opencode.json", "opencode.jsonc"].map((name) =>
        join(home, "config", "opencode", name),
      ),
    );
    expect(result.explicit.ok).toBe(true);
    if (!result.explicit.ok) throw new Error(result.explicit.error.message);
    expect(result.explicit.value.map((client) => client.id)).toEqual([
      "codex",
      "amp",
      "gemini-cli",
      "fx",
      "windsurf",
    ]);
    expect(result.explicit.value[0]?.configPath).toBe(
      join(home, "selected-codex", "config.toml"),
    );
    expect(
      result.explicit.value.find((client) => client.id === "fx"),
    ).toMatchObject({ format: "fx", privateProfile: true });
    expect(result.detected.ok).toBe(true);
    if (!result.detected.ok) throw new Error(result.detected.error.message);
    expect(result.detected.value.map((client) => client.id)).toEqual([
      "claude-code",
      "cursor",
      "amp",
    ]);
    expect(result.project.ok, JSON.stringify(result.project)).toBe(true);
    if (!result.project.ok) throw new Error(result.project.error.message);
    expect(result.project.value[0]?.format).toBe("copilot_cli_project");
    expect(
      result.project.value.map(({ configPath, scope }) => ({
        configPath,
        scope,
      })),
    ).toEqual([
      {
        configPath: join(home, "project", ".github", "mcp.json"),
        scope: "project",
      },
      ...(process.platform === "win32"
        ? []
        : [
            {
              configPath: join(home, "project", ".kilocode", "kilo.jsonc"),
              scope: "project",
            },
          ]),
      {
        configPath: join(home, "project", "opencode.jsonc"),
        scope: "project",
      },
    ]);
    for (const refused of [
      result.onlyGlobal,
      result.defaultProject,
      result.projectAmp,
      result.unknown,
      ...(result.blockedCandidate === null ? [] : [result.blockedCandidate]),
      result.unknownDetection,
    ]) {
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error("Expected preflight refusal.");
      expect(refused.error.tag).toBe("ConfigurationError");
    }
    expect(result.cancelled).toMatchObject({
      ok: false,
      error: { tag: "AnalysisCancelledError" },
    });
  } finally {
    await processes.shutdown();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

const assertKiloNativeLayers = (
  result: z.infer<typeof catalogObservationsSchema>,
  home: string,
): void => {
  if (process.platform === "win32") {
    for (const name of [
      "ancestorLayers",
      "projectReadonly",
      "noRepository",
      "disabled",
      "invalidGit",
      "unterminatedGit",
      "linkedWorktree",
      "missingTarget",
      "cancelledGit",
      "whitespaceWorktree",
      "blockedCandidate",
    ] as const)
      expect(result[name]).toBeNull();
    return;
  }
  const client = (
    name:
      | "ancestorLayers"
      | "selectedLayers"
      | "projectReadonly"
      | "linkedWorktree",
  ) => {
    const value = result[name];
    if (value === null) throw Error(`Missing POSIX ${name} observation`);
    if (!value.ok) throw Error(value.error.message);
    const entry = value.value[0];
    if (!entry) throw Error(`No ${name} client`);
    return entry;
  };
  const project = join(home, "project");
  const native = [
    join(project, "kilo.json"),
    join(project, "nested", "kilo.jsonc"),
    join(project, "opencode.json"),
    join(project, "nested", "opencode.jsonc"),
    join(project, "nested", ".kilocode", "kilo.jsonc"),
    join(project, ".kilocode", "kilo.jsonc"),
  ];
  expect(client("ancestorLayers")).toMatchObject({
    configPath: native.at(-1),
    configPaths: native,
  });
  expect(client("selectedLayers")).toMatchObject({
    configPath: join(home, "override-dir", "opencode.json"),
    configPaths: [
      join(home, "override.json"),
      join(home, "override-dir", "kilo.jsonc"),
      join(home, "override-dir", "opencode.json"),
    ],
    inlineConfiguration: { origin: "KILO_CONFIG_CONTENT" },
  });
  expect(client("projectReadonly")).toMatchObject({
    configPath: native.at(-1),
    configPaths: [
      join(home, "override.json"),
      ...native,
      join(home, "override-dir", "kilo.jsonc"),
      join(home, "override-dir", "opencode.json"),
    ],
  });
  expect(client("linkedWorktree")).toMatchObject({
    configPath: native.at(-1),
    configPaths: [
      ...native.slice(0, 4),
      join(home, "primary", "nested", ".kilo", "opencode.json"),
      ...native.slice(4),
    ],
  });
  if (result.missingTarget === null)
    throw Error("Missing POSIX planned target observation");
  expect(result.missingTarget.ok).toBe(true);
  if (!result.missingTarget.ok) throw Error(result.missingTarget.error.message);
  const planned = join(home, "empty-worktree", ".kilo", "kilo.jsonc");
  expect(result.missingTarget.value[0]).toMatchObject({
    configPath: planned,
    configPaths: [
      planned,
      join(home, "override-dir", "kilo.jsonc"),
      join(home, "override-dir", "opencode.json"),
    ],
  });
  expect(result.cancelledGit).toMatchObject({
    ok: false,
    error: { tag: "AnalysisCancelledError" },
  });
  for (const name of [
    "repeatedFile",
    "repeatedDirectory",
    "whitespaceWorktree",
  ] as const) {
    const entry = result[name];
    if (entry === null) throw Error(`Missing POSIX ${name} observation`);
    if (!entry.ok) throw Error(entry.error.message);
  }
  if (result.repeatedFile.ok)
    expect(result.repeatedFile.value[0]).toMatchObject({
      configPath: join(home, "layered", "kilo", "kilo.json"),
      configPaths: [
        ...[
          "config.json",
          "kilo.json",
          "kilo.jsonc",
          "opencode.json",
          "opencode.jsonc",
        ].map((name) => join(home, "layered", "kilo", name)),
        join(home, "layered", "kilo", "kilo.json"),
      ],
    });
  if (result.repeatedDirectory.ok)
    expect(result.repeatedDirectory.value[0]).toMatchObject({
      configPath: join(home, ".kilocode", "kilo.json"),
      configPaths: [
        join(home, ".kilocode", "kilo.json"),
        join(home, ".kilo", "opencode.json"),
      ],
    });
  if (result.whitespaceWorktree?.ok)
    expect(result.whitespaceWorktree.value[0]?.configPath).toBe(
      join(home, " worktree\nwith-space ", ".kilo", "kilo.jsonc"),
    );
  for (const name of [
    "noRepository",
    "disabled",
    "invalidInline",
    "invalidGit",
    "unterminatedGit",
  ] as const)
    expect(result[name]).toMatchObject({
      ok: false,
      error: { tag: "ConfigurationError" },
    });
};
