import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { beforeAll, expect, it } from "vitest";
import { z } from "zod";

import { mcpRegistrationReportSchema } from "./contracts/mcpRegistration.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../tests/support/workspace/workspaceFixture.js";
import { createTestProcessRegistry } from "../tests/support/process/processFixture.js";

const require = createRequire(import.meta.url);
const CHILD_PROGRAM = `
  import { homedir } from 'node:os';
  import { join, relative, isAbsolute, delimiter } from 'node:path';
  import { mkdir, writeFile, readFile, readdir, realpath, stat } from 'node:fs/promises';
  const ambient = process.env.HOME;
  if (!ambient || await realpath(ambient) !== await realpath(homedir())) throw Error('Actual temporary HOME was not selected before importing writers.');
  const root = process.env.REA_REGISTRATION_FIXTURE_ROOT;
  const inside = (parent, path) => { const part = relative(parent, path); if (part.startsWith('..') || isAbsolute(part)) throw Error('Fixture path escaped owned root.'); };
  inside(root, ambient);
  for (const key of ['USERPROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','APPDATA','LOCALAPPDATA']) inside(ambient, process.env[key]);
  const project = join(root, 'project');
  await mkdir(project); process.chdir(project);
  const bin = join(root, 'bin'); await mkdir(bin);
  const helperLog = join(root, 'helper-invocations');
  const witness = join(bin, 'acquisition.cjs');
  await writeFile(witness, "require('node:fs').appendFileSync(process.env.REA_REGISTRATION_HELPER_LOG, 'unexpected acquisition\\n'); process.exit(79);\\n");
  for (const runner of ['npx','pnpx','bunx']) {
    if (process.platform === 'win32') await writeFile(join(bin, runner + '.cmd'), '@"' + process.execPath + '" "' + witness + '"\\r\\n');
    else await writeFile(join(bin, runner), '#!' + process.execPath + '\\nrequire(' + JSON.stringify(witness) + ');\\n', { mode: 0o700 });
  }
  const { createCli, closeCliResources } = await import(${JSON.stringify(new URL("./cli.ts", import.meta.url).href)});
  const { resolveMcpRegistrationClients } = await import(${JSON.stringify(new URL("./application/McpRegistrationCatalog.ts", import.meta.url).href)});
  const { ArtifactResourceScope } = await import(${JSON.stringify(new URL("./artifacts/ArtifactResourceScope.ts", import.meta.url).href)});
  const preflightResources = new ArtifactResourceScope();
  const { parse: parseToml } = await import(${JSON.stringify(pathToFileURL(require.resolve("smol-toml")).href)});
  const { parse: parseYaml } = await import(${JSON.stringify(pathToFileURL(require.resolve("yaml")).href)});
  const environmentFor = async (name) => {
    const home = join(root, name); await mkdir(home);
    const environment = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home,'config'), XDG_DATA_HOME: join(home,'data'), XDG_CACHE_HOME: join(home,'cache'), XDG_STATE_HOME: join(home,'state'), APPDATA: join(home,'appdata'), LOCALAPPDATA: join(home,'localappdata'), PATH: bin + delimiter + process.env.PATH, REA_REGISTRATION_HELPER_LOG: helperLog, REA_TEST_CALLER_VISIBLE: 'fixture-only' };
    for (const key of ['HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','APPDATA','LOCALAPPDATA']) inside(home, environment[key]);
    return environment;
  };
  const serve = async (environment, arguments_) => {
    let output = '', exitCode = 0;
    await createCli(environment).serve(arguments_, { stdout(text) { output += text; }, exit(code) { exitCode = code; } });
    const document = JSON.parse(output);
    if (Array.isArray(document.clients)) for (const client of document.clients) { inside(environment.HOME, client.config_path); if (client.backup_path) inside(environment.HOME, client.backup_path); }
    return { exitCode, document };
  };
  const invoke = async (environment, agents, command, global = true) => {
    // Check the producing paths before granting the public handler any write authority.
    const targets = await resolveMcpRegistrationClients({ agents, global, cwd: project, home: environment.HOME, platform: process.platform, environment }, preflightResources);
    if (targets.ok) for (const target of targets.value) inside(global ? environment.HOME : project, target.configPath);
    return serve(environment, ['mcp','add', ...agents.flatMap(agent => ['--agent', agent]), ...(command === undefined ? [] : ['--command',command]), ...(global ? [] : ['--no-global']), '--json']);
  };
  const exists = async (path) => readFile(path,'utf8').then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  const tree = async (path) => (await readdir(path,{recursive:true})).sort();
  const command = '"/fixture/server path" "" --mcp';
  let result;
  try {
    const defaultsEnvironment = await environmentFor('defaults');
    const schema = await serve(defaultsEnvironment, ['mcp','add','--schema','--json']);
    const all = await invoke(defaultsEnvironment, [], undefined);
    const native = [];
    for (const client of all.document.clients ?? []) {
      const text = await readFile(client.config_path, 'utf8');
      const parsed = ['codex','grok-build'].includes(client.client) ? parseToml(text) : client.client === 'hermes' ? parseYaml(text,{version:'1.1'}) : client.client === 'goose' ? parseYaml(text,{version:'1.2'}) : JSON.parse(text);
      const key = client.client === 'amp' ? 'amp.mcpServers' : ['codex','grok-build','hermes'].includes(client.client) ? 'mcp_servers' : ['kilo-code','opencode'].includes(client.client) ? 'mcp' : client.client === 'goose' ? 'extensions' : client.client === 'zed' ? 'context_servers' : client.client === 'vscode' ? 'servers' : 'mcpServers';
      const entry = parsed[key]?.rea;
      const words = client.client === 'goose' ? [entry?.cmd,...entry?.args ?? []] : Array.isArray(entry?.command) ? entry.command : [entry?.command,...entry?.args ?? []];
      native.push({ client: client.client, command: words[0], args: words.slice(1), ambientPersisted: Object.values(entry ?? {}).some(value => value && typeof value === 'object' && value.REA_TEST_CALLER_VISIBLE !== undefined) });
    }
    const repeatedAll = await invoke(defaultsEnvironment, [], undefined);
    const mixedEnvironment = await environmentFor('mixed');
    const cursorPath = join(mixedEnvironment.HOME,'.cursor','mcp.json');
    const ampPath = join(mixedEnvironment.HOME,'.config','amp','settings.json');
    const cursorOriginal = JSON.stringify({mcpServers:{rea:{command:'old',args:['old'],env:{KEEP:'fixture'},disabled:true,custom:{policy:'retained'}},peer:{command:'peer'}},theme:'dark'}) + '\\n';
    const ampOriginal = JSON.stringify({'amp.mcpServers':{rea:{command:'old',args:['old'],env:{KEEP:'amp-fixture'},disabled:false},peer:{command:'peer'}},theme:'dark'}) + '\\n';
    await mkdir(join(mixedEnvironment.HOME,'.cursor'),{recursive:true}); await writeFile(cursorPath,cursorOriginal);
    await mkdir(join(mixedEnvironment.HOME,'.config','amp'),{recursive:true}); await writeFile(ampPath,ampOriginal);
    const mixed = await invoke(mixedEnvironment,['cursor','amp'],command);
    const mixedBytes = [await readFile(cursorPath,'utf8'),await readFile(ampPath,'utf8')];
    const inodeBefore = [(await stat(cursorPath)).ino,(await stat(ampPath)).ino];
    const mixedRepeat = await invoke(mixedEnvironment,['cursor','amp'],command);
    const inodeAfter = [(await stat(cursorPath)).ino,(await stat(ampPath)).ino];
    const mixedChecks = { cursor:JSON.parse(mixedBytes[0]),amp:JSON.parse(mixedBytes[1]),backupsMatch:(await readFile(cursorPath+'.rea.backup','utf8'))===cursorOriginal && (await readFile(ampPath+'.rea.backup','utf8'))===ampOriginal, inodePreserved:JSON.stringify(inodeBefore)===JSON.stringify(inodeAfter), backupFiles:(await tree(mixedEnvironment.HOME)).filter(path=>path.includes('.rea.backup')) };
    const failureEnvironment = await environmentFor('partial');
    const broken = join(failureEnvironment.HOME,'.cursor','mcp.json');
    await mkdir(join(failureEnvironment.HOME,'.cursor')); await writeFile(broken,'{"mcpServers":[]}');
    const failedThenSuccess = await invoke(failureEnvironment,['cursor','amp'],command);
    const successThenFailed = await invoke(failureEnvironment,['amp','cursor'],'"/fixture/server path" "" --changed');
    const malformedRetained = await readFile(broken,'utf8');
    const runnerEnvironment = await environmentFor('runner-launchers');
    const runners = [];
    for (const runner of ['npx','pnpx','bunx']) {
      const invocation = await invoke(runnerEnvironment,['cursor'],runner + ' "" package --mcp');
      const entry = JSON.parse(await readFile(join(runnerEnvironment.HOME,'.cursor','mcp.json'),'utf8')).mcpServers.rea;
      runners.push({runner,invocation,entry});
    }
    const refusedEnvironment = await environmentFor('refused');
    const refusedBefore = await tree(refusedEnvironment.HOME);
    const refused = [];
    for (const agents of [['cursor','goose'],['cursor','amp'],[]]) refused.push(await invoke(refusedEnvironment,agents,command,false));
    const refusedAfter = await tree(refusedEnvironment.HOME);
    const remoteEnvironment = await environmentFor('remote-refused');
    const remoteBefore = await tree(remoteEnvironment.HOME);
    const remote = [];
    for (const source of ['https://fixture.invalid/mcp','https://fixture-user:fixture-secret@fixture.invalid/mcp']) remote.push(await invoke(remoteEnvironment,['cursor'],source));
    const remoteDidNotWrite = JSON.stringify(remoteBefore) === JSON.stringify(await tree(remoteEnvironment.HOME));
    result = { remote,remoteDidNotWrite, schema,all,native,repeatedAll,mixed,mixedRepeat,mixedChecks,failedThenSuccess,successThenFailed,malformedRetained,runners,refused,refusalDidNotWrite:JSON.stringify(refusedBefore)===JSON.stringify(refusedAfter),ambientUnchanged:(await tree(ambient)).length===0,helperAcquisition:await exists(helperLog),expectedDefault:{command:process.execPath,args:[process.argv[1],'mcp']} };
  } finally { await closeCliResources(); await preflightResources.close(); }
  console.log(JSON.stringify(result));
`;

const invocationSchema = z.object({
  exitCode: z.number(),
  document: z.unknown(),
});
const observationsSchema = z.object({
  schema: invocationSchema,
  all: invocationSchema,
  repeatedAll: invocationSchema,
  mixed: invocationSchema,
  mixedRepeat: invocationSchema,
  failedThenSuccess: invocationSchema,
  successThenFailed: invocationSchema,
  native: z.array(
    z.object({
      client: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      ambientPersisted: z.boolean(),
    }),
  ),
  expectedDefault: z.object({ command: z.string(), args: z.array(z.string()) }),
  mixedChecks: z.object({
    cursor: z.unknown(),
    amp: z.unknown(),
    backupsMatch: z.boolean(),
    inodePreserved: z.boolean(),
    backupFiles: z.array(z.string()),
  }),
  runners: z.array(
    z.object({
      runner: z.enum(["npx", "pnpx", "bunx"]),
      invocation: invocationSchema,
      entry: z.unknown(),
    }),
  ),
  malformedRetained: z.string(),
  refused: z.array(invocationSchema),
  remote: z.array(invocationSchema),
  remoteDidNotWrite: z.boolean(),
  refusalDidNotWrite: z.boolean(),
  ambientUnchanged: z.boolean(),
  helperAcquisition: z.boolean(),
});

const captureRegistration = async () => {
  const { root } = await createTestWorkspace("rea-cli-registration-matrix-");
  const processes = createTestProcessRegistry();
  try {
    const home = join(root, "ambient");
    await mkdir(home);
    const entry = join(root, "entry.mjs");
    await writeFile(entry, CHILD_PROGRAM);
    const child = await processes.run(
      process.execPath,
      ["--import", "tsx", entry],
      {
        timeoutMs: 20_000,
        env: {
          PATH: join(root, "bin") + delimiter + process.env.PATH,
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
          REA_REGISTRATION_FIXTURE_ROOT: root,
          REA_LOG_LEVEL: "silent",
        },
      },
    );
    expect(child.exitCode, child.stderr).toBe(0);
    return observationsSchema.parse(JSON.parse(child.stdout));
  } finally {
    await processes.shutdown();
    await removeTestWorkspace(root);
  }
};

let observed: z.infer<typeof observationsSchema>;
beforeAll(async () => {
  observed = await captureRegistration();
}, 30_000);

it("validates named input/output schemas against every registration report", () => {
  const schemas = z
    .object({
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()),
    })
    .parse(observed.schema.document);
  expect(observed.schema.exitCode).toBe(0);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const input = ajv.compile(schemas.inputSchema);
  const output = ajv.compile(schemas.outputSchema);
  expect(
    input({
      agent: ["cursor", "amp"],
      command: '"/fixture/server path" "" --mcp',
    }),
    JSON.stringify(input.errors),
  ).toBe(true);
  expect(input({ agent: "amp" })).toBe(false);
  for (const invocation of [
    observed.all,
    observed.repeatedAll,
    observed.mixed,
    observed.mixedRepeat,
    observed.failedThenSuccess,
    observed.successThenFailed,
    ...observed.runners.map(({ invocation }) => invocation),
  ])
    expect(output(invocation.document), JSON.stringify(output.errors)).toBe(
      true,
    );
});

it("preserves default and mixed launcher facts, metadata, backups and no-op identity", () => {
  const all = mcpRegistrationReportSchema.parse(observed.all.document);
  expect(observed.all.exitCode).toBe(0);
  expect(all.ok).toBe(true);
  expect(all.clients).toHaveLength(26);
  expect(all.clients.every((client) => client.status === "configured")).toBe(
    true,
  );
  expect({ command: all.command, args: all.args }).toEqual(
    observed.expectedDefault,
  );
  for (const native of observed.native) {
    expect(
      { command: native.command, args: native.args },
      native.client,
    ).toEqual(observed.expectedDefault);
    expect(native.ambientPersisted, native.client).toBe(false);
  }
  expect(observed.native).toHaveLength(26);
  const repeated = mcpRegistrationReportSchema.parse(
    observed.repeatedAll.document,
  );
  expect(observed.repeatedAll.exitCode).toBe(0);
  expect(
    repeated.clients.every((client) => client.status === "unchanged"),
  ).toBe(true);
  const mixed = mcpRegistrationReportSchema.parse(observed.mixed.document);
  expect(observed.mixed.exitCode).toBe(0);
  expect({ command: mixed.command, args: mixed.args }).toEqual({
    command: "/fixture/server path",
    args: ["", "--mcp"],
  });
  expect(
    mixed.clients.map((client) => ({
      client: client.client,
      status: client.status,
    })),
  ).toEqual([
    { client: "cursor", status: "configured" },
    { client: "amp", status: "configured" },
  ]);
  expect(observed.mixedChecks.cursor).toMatchObject({
    mcpServers: {
      rea: {
        command: "/fixture/server path",
        args: ["", "--mcp"],
        env: { KEEP: "fixture" },
        disabled: true,
        custom: { policy: "retained" },
      },
      peer: { command: "peer" },
    },
    theme: "dark",
  });
  expect(observed.mixedChecks.amp).toMatchObject({
    "amp.mcpServers": {
      rea: {
        command: "/fixture/server path",
        args: ["", "--mcp"],
        env: { KEEP: "amp-fixture" },
        disabled: false,
      },
      peer: { command: "peer" },
    },
    theme: "dark",
  });
  expect(observed.mixedChecks.backupsMatch).toBe(true);
  expect(observed.mixedChecks.inodePreserved).toBe(true);
  expect(observed.mixedChecks.backupFiles).toHaveLength(2);
  expect(
    mcpRegistrationReportSchema
      .parse(observed.mixedRepeat.document)
      .clients.every((client) => client.status === "unchanged"),
  ).toBe(true);
});

it("retains actionable failures and completed siblings in either order", () => {
  const firstFailure = mcpRegistrationReportSchema.parse(
    observed.failedThenSuccess.document,
  );
  const lastFailure = mcpRegistrationReportSchema.parse(
    observed.successThenFailed.document,
  );
  expect(observed.failedThenSuccess.exitCode).toBe(1);
  expect(firstFailure.ok).toBe(false);
  expect(firstFailure.clients.map((client) => client.status)).toEqual([
    "failed",
    "configured",
  ]);
  expect(observed.successThenFailed.exitCode).toBe(1);
  expect(lastFailure.ok).toBe(false);
  expect(lastFailure.clients.map((client) => client.status)).toEqual([
    "configured",
    "failed",
  ]);
  expect(observed.malformedRetained).toBe('{"mcpServers":[]}');
  for (const client of [...firstFailure.clients, ...lastFailure.clients])
    if (client.status === "failed")
      expect(client.error.reason).toContain(".cursor");
});

it("refuses remote transport and project-scope escalation before writes", () => {
  for (const invocation of observed.remote) {
    expect(invocation.exitCode).toBe(1);
    expect(invocation.document).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({
          code: "unsupported_transport",
          path: "command",
        }),
      ],
    });
    expect(JSON.stringify(invocation.document)).not.toContain("fixture-secret");
    expect(JSON.stringify(invocation.document)).not.toContain("fixture-user");
  }
  expect(observed.remoteDidNotWrite).toBe(true);
  for (const refused of observed.refused) {
    expect(refused.exitCode).toBe(1);
    expect(refused.document).toMatchObject({ code: "VALIDATION_ERROR" });
  }
  expect(observed.refusalDidNotWrite).toBe(true);
});

it("preserves runner launcher data without acquisition or ambient writes", () => {
  for (const { runner, invocation, entry } of observed.runners) {
    expect(invocation.exitCode).toBe(0);
    const report = mcpRegistrationReportSchema.parse(invocation.document);
    expect({ command: report.command, args: report.args }).toEqual({
      command: runner,
      args: ["", "package", "--mcp"],
    });
    expect(entry).toMatchObject({
      command: runner,
      args: ["", "package", "--mcp"],
    });
  }
  expect(observed.ambientUnchanged).toBe(true);
  expect(observed.helperAcquisition).toBe(false);
});
