import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { createTestProcessRegistry } from "../../tests/support/process/processFixture.js";

const CONFIGURATION_PROGRAM = `
  import { homedir } from 'node:os';
  import { isAbsolute, join, relative, resolve } from 'node:path';
  import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
  const home = process.env.HOME;
  if (!home || await realpath(homedir()) !== await realpath(home))
    throw Error('Fixture HOME must be selected before importing setup owners.');
  const insideHome = (path) => {
    const selected = relative(home, resolve(path));
    if (selected.startsWith('..') || isAbsolute(selected)) throw Error('Fixture path escapes HOME.');
    return path;
  };
  for (const key of ['USERPROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','APPDATA','LOCALAPPDATA'])
    insideHome(process.env[key] ?? '');
  const { configureClientConfiguration, clientConfigurationAligned, inspectClientConfiguration } =
    await import(${JSON.stringify(new URL("./SetupClientConfiguration.ts", import.meta.url).href)});
  const { currentClientRegistrationCommand } =
    await import(${JSON.stringify(new URL("./ClientRegistrationIdentity.ts", import.meta.url).href)});
  const { supportedClientRegistrationProfile } =
    await import(${JSON.stringify(new URL("./SupportedClients.ts", import.meta.url).href)});
  const command = currentClientRegistrationCommand();
  if (command.length === 0) throw Error('Fixture process has no owned current entrypoint.');
  const exercise = async (name, format) => {
    const directory = insideHome(join(home, 'config', name));
    const configPath = insideHome(join(directory, 'mcp.json'));
    await mkdir(directory, { recursive: true });
    const client = { name, format, configPath, registrationProfile: supportedClientRegistrationProfile(name) };
    await writeFile(configPath, '{}');
    const initial = await configureClientConfiguration(client, {}, command);
    if (initial.status !== 'configured') throw Error('Initial fixture configuration failed: ' + JSON.stringify(initial));
    const original = JSON.parse(await readFile(configPath, 'utf8'));
    const strictControl = {
      aligned: await clientConfigurationAligned(client, {}, command),
      inspection: (await inspectClientConfiguration(client, {}, command)).status,
      status: (await configureClientConfiguration(client, {}, command)).status,
    };
    const jsonc = '// retained original source\\n' + JSON.stringify(original, null, 2).replace(/}$/, ',\\n}') + '\\n';
    await writeFile(configPath, jsonc);
    const before = {
      aligned: await clientConfigurationAligned(client, {}, command),
      inspection: (await inspectClientConfiguration(client, {}, command)).status,
    };
    const filesBefore = await readdir(directory);
    const repaired = await configureClientConfiguration(client, {}, command);
    const after = await readFile(configPath, 'utf8');
    let strict = false, document;
    try { document = JSON.parse(after); strict = true; } catch {}
    const afterState = await stat(configPath);
    const filesAfter = await readdir(directory);
    const repeat = await configureClientConfiguration(client, {}, command);
    const repeatState = await stat(configPath);
    return {
      strictControl, before, status: repaired.status, jsonc, after, strict, original, document,
      alignedAfter: await clientConfigurationAligned(client, {}, command),
      backup: repaired.backupPath === undefined ? null : await readFile(insideHome(repaired.backupPath), 'utf8'),
      repeatStatus: repeat.status,
      stableRepeat: afterState.ino === repeatState.ino && afterState.mtimeMs === repeatState.mtimeMs,
      filesBefore, filesAfter, filesRepeat: await readdir(directory),
    };
  };
  console.log(JSON.stringify({ command, copilot: await exercise('copilot_cli', 'copilot_cli'), standard: await exercise('cursor', 'json') }));
`;

const observedConfiguration = z.object({
  strictControl: z.object({
    aligned: z.boolean(),
    inspection: z.string(),
    status: z.string(),
  }),
  before: z.object({ aligned: z.boolean(), inspection: z.string() }),
  status: z.string(),
  jsonc: z.string(),
  after: z.string(),
  strict: z.boolean(),
  original: z.unknown(),
  document: z.unknown().optional(),
  alignedAfter: z.boolean(),
  backup: z.string().nullable(),
  repeatStatus: z.string(),
  stableRepeat: z.boolean(),
  filesBefore: z.array(z.string()),
  filesAfter: z.array(z.string()),
  filesRepeat: z.array(z.string()),
});

it("repairs equal-launcher Copilot JSONC syntax while strict JSON and standard JSONC remain idempotent", async () => {
  const home = await createTestTempDirectory("rea-setup-native-syntax-");
  const entrypoint = join(home, "native-syntax.mjs");
  await mkdir(join(home, "config"));
  await writeFile(entrypoint, CONFIGURATION_PROGRAM);
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
        },
      },
    );
    expect(child.exitCode, child.stderr).toBe(0);
    const { copilot, standard, command } = z
      .object({
        command: z.array(z.string()).min(1),
        copilot: observedConfiguration,
        standard: observedConfiguration,
      })
      .parse(JSON.parse(child.stdout));
    expect(command.at(-1)).toBe("mcp");
    expect(copilot.strictControl).toEqual({
      aligned: true,
      inspection: "already_current",
      status: "unchanged",
    });
    expect(copilot.before).toEqual({ aligned: false, inspection: "update" });
    expect(copilot.status).toBe("configured");
    expect(copilot.strict).toBe(true);
    expect(copilot.document).toEqual(copilot.original);
    expect(copilot.backup).toBe(copilot.jsonc);
    expect(copilot.alignedAfter).toBe(true);
    expect(copilot.repeatStatus).toBe("unchanged");
    expect(copilot.stableRepeat).toBe(true);
    expect(copilot.filesRepeat).toEqual(copilot.filesAfter);
    expect(standard.strictControl).toEqual({
      aligned: true,
      inspection: "already_current",
      status: "unchanged",
    });
    expect(standard.before).toEqual({
      aligned: true,
      inspection: "already_current",
    });
    expect(standard.status).toBe("unchanged");
    expect(standard.after).toBe(standard.jsonc);
    expect(standard.filesAfter).toEqual(standard.filesBefore);
    expect(standard.repeatStatus).toBe("unchanged");
    expect(standard.stableRepeat).toBe(true);
  } finally {
    await processes.shutdown();
  }
});
