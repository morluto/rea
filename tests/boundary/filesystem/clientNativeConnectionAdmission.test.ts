import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestProcessRegistry } from "../../support/process/processFixture.js";

const PROGRAM = `
  import { homedir } from 'node:os';
  import { isAbsolute, join, relative, resolve } from 'node:path';
  import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
  const home = process.env.HOME;
  if (!home || await realpath(homedir()) !== await realpath(home))
    throw Error('Fixture HOME must be selected before importing registration owners.');
  const insideHome = (path) => {
    const selected = relative(home, resolve(path));
    if (selected.startsWith('..') || isAbsolute(selected)) throw Error('Fixture path escapes HOME.');
    return path;
  };
  for (const key of ['USERPROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','APPDATA','LOCALAPPDATA','GEMINI_CLI_SYSTEM_SETTINGS_PATH','GEMINI_CLI_SYSTEM_DEFAULTS_PATH','GEMINI_CLI_TRUSTED_FOLDERS_PATH'])
    insideHome(process.env[key] ?? '');
  process.chdir(home);
  const { readClientRegistrationStatuses } = await import(${JSON.stringify(new URL("../../../src/application/ClientRegistrationStatus.ts", import.meta.url).href)});
  const { currentClientRegistrationCommand } = await import(${JSON.stringify(new URL("../../../src/application/ClientRegistrationIdentity.ts", import.meta.url).href)});
  const { CURRENT_ENTRYPOINT_PATH } = await import(${JSON.stringify(new URL("../../../src/process/CurrentEntrypointPath.ts", import.meta.url).href)});
  const { supportedClients } = await import(${JSON.stringify(new URL("../../../src/application/SupportedClients.ts", import.meta.url).href)});
  const { registerMcpClient } = await import(${JSON.stringify(new URL("../../../src/application/McpClientRegistration.ts", import.meta.url).href)});
  const { mcpClientRegistrationProfile } = await import(${JSON.stringify(new URL("../../../src/application/McpRegistrationCatalog.ts", import.meta.url).href)});
  const { ArtifactResourceScope } = await import(${JSON.stringify(new URL("../../../src/artifacts/ArtifactResourceScope.ts", import.meta.url).href)});
  const { ConfigurationError } = await import(${JSON.stringify(new URL("../../../src/domain/configurationErrors.ts", import.meta.url).href)});
  const [command, ...args] = currentClientRegistrationCommand();
  if (!command || !CURRENT_ENTRYPOINT_PATH) throw Error('Missing owned fixture entrypoint.');
  const gemini = supportedClients(home, process.platform, process.env).find(client => client.name === 'gemini_cli');
  if (!gemini) throw Error('Missing supported Gemini profile.');
  const configPath = insideHome(gemini.configPath);
  await mkdir(join(configPath, '..'), { recursive: true });
  const row = { command, args, env: { REA_MCP_INPUT_SCHEMA_PROFILE: 'compact' } };
  const cases = [
    ['ignored transport', { transport: { operator: true } }],
    ['HTTP selected', { httpUrl: 'https://fixture.invalid/http' }],
    ['malformed truthy HTTP selector', { httpUrl: { operator: true } }],
    ['SSE selected', { url: 'https://fixture.invalid/sse' }],
    ['empty URL selectors', { httpUrl: '', url: '', transport: { operator: true } }],
  ];
  const statuses = [];
  for (const [label, fields] of cases) {
    const original = JSON.stringify({ mcpServers: { rea: { ...row, ...fields } } });
    await writeFile(configPath, original);
    const status = (await readClientRegistrationStatuses(home, CURRENT_ENTRYPOINT_PATH, {
      environment: process.env, selectedClientIds: ['gemini_cli'],
    })).find(status => status.client === 'gemini_cli');
    if (!status) throw Error('Missing Gemini status.');
    statuses.push({ label, state: status.state, identity: status.command_identity,
      sourceUnchanged: await readFile(configPath, 'utf8') === original });
  }
  const directory = insideHome(join(home, 'layered'));
  await mkdir(directory);
  const target = insideHome(join(directory, 'target.json'));
  const higher = insideHome(join(directory, 'readonly.json'));
  const source = JSON.stringify({ mcpServers: { rea: { ...row, httpUrl: 'https://fixture.invalid/selected' } } });
  await writeFile(higher, source);
  const client = { id: 'gemini-cli', displayName: 'Gemini CLI', format: 'json',
    registrationProfile: mcpClientRegistrationProfile('gemini-cli'),
    scope: 'global', configPath: target, configPaths: [target, higher] };
  const exists = async path => {
    try { await access(path); return true; }
    catch (cause) { if (cause?.code === 'ENOENT') return false; throw cause; }
  };
  const resources = new ArtifactResourceScope();
  try {
    const conflict = await registerMcpClient(client, { command, args }, undefined, resources);
    const refused = { ok: conflict.ok, typed: !conflict.ok && conflict.error instanceof ConfigurationError,
      targetExists: await exists(target), backupExists: await exists(target + '.rea.backup'),
      higherUnchanged: await readFile(higher, 'utf8') === source };
    const harmless = JSON.stringify({ mcpServers: { rea: { ...row, operator: { preserve: true } } } });
    await writeFile(higher, harmless);
    const control = await registerMcpClient(client, { command, args }, undefined, resources);
    console.log(JSON.stringify({ statuses, refused, control: { ok: control.ok,
      status: control.ok ? control.value.status : control.error.message,
      targetExists: await exists(target), higherUnchanged: await readFile(higher, 'utf8') === harmless } }));
  } finally { await resources.close(); }
`;

const observed = z.object({
  statuses: z.array(
    z.object({
      label: z.string(),
      state: z.string(),
      identity: z.string(),
      sourceUnchanged: z.boolean(),
    }),
  ),
  refused: z.object({
    ok: z.boolean(),
    typed: z.boolean(),
    targetExists: z.boolean(),
    backupExists: z.boolean(),
    higherUnchanged: z.boolean(),
  }),
  control: z.object({
    ok: z.boolean(),
    status: z.string(),
    targetExists: z.boolean(),
    higherUnchanged: z.boolean(),
  }),
});

it("keeps owned Gemini launcher facts separate from native connection admission through status and publication", async () => {
  const home = await createTestTempDirectory("rea-native-connection-");
  const entrypoint = join(home, "native-connection.mjs");
  await writeFile(entrypoint, PROGRAM);
  const processes = createTestProcessRegistry();
  try {
    const child = await processes.run(
      process.execPath,
      ["--import", "tsx", entrypoint],
      {
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
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, "system-settings.json"),
          GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, "system-defaults.json"),
          GEMINI_CLI_TRUSTED_FOLDERS_PATH: join(home, "trusted-folders.json"),
          GEMINI_CLI_TRUST_WORKSPACE: "true",
        },
      },
    );
    expect(child.exitCode, child.stderr).toBe(0);
    const result = observed.parse(JSON.parse(child.stdout));
    expect(result).toEqual({
      statuses: [
        {
          label: "ignored transport",
          state: "aligned",
          identity: "owned",
          sourceUnchanged: true,
        },
        {
          label: "HTTP selected",
          state: "unknown",
          identity: "owned",
          sourceUnchanged: true,
        },
        {
          label: "malformed truthy HTTP selector",
          state: "unknown",
          identity: "owned",
          sourceUnchanged: true,
        },
        {
          label: "SSE selected",
          state: "unknown",
          identity: "owned",
          sourceUnchanged: true,
        },
        {
          label: "empty URL selectors",
          state: "aligned",
          identity: "owned",
          sourceUnchanged: true,
        },
      ],
      refused: {
        ok: false,
        typed: true,
        targetExists: false,
        backupExists: false,
        higherUnchanged: true,
      },
      control: {
        ok: true,
        status: "configured",
        targetExists: true,
        higherUnchanged: true,
      },
    });
  } finally {
    await processes.shutdown();
  }
});
