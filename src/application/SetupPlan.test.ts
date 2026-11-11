import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import { runDoctor } from "./Doctor.js";
import { createDoctorHostFixture } from "./Doctor.fixture.js";
import { FakeSetupHost } from "./Setup.fixture.js";
import { readClientRegistrationStatuses } from "./ClientRegistrationStatus.js";
import { discoverSetupState } from "./SetupPlan.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../tests/support/workspace/workspaceFixture.js";

/** Keep a workspace child under its root before any filesystem call. */
const pathInside = (root: string, ...parts: string[]): string => {
  const candidate = resolve(root, ...parts);
  const displacement = relative(root, candidate);
  if (
    displacement === ".." ||
    displacement.startsWith(`..${sep}`) ||
    isAbsolute(displacement)
  )
    throw new TypeError("temporary path escaped its workspace");
  return candidate;
};

/** Admit the running entrypoint only when it stays inside its own directory. */
const symlinkTarget = (entrypoint: string): string => {
  const target = resolve(entrypoint);
  const directory = resolve(dirname(target));
  if (!target.startsWith(`${directory}${sep}`))
    throw new TypeError("entrypoint escaped its directory");
  return target;
};

it.skipIf(process.platform === "win32")(
  "retains doctor ownership observations when a launcher alias becomes unavailable before discovery",
  async () => {
    const workspace = await createTestWorkspace("rea-plan-command-identity-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const home = pathInside(workspace.root, ".");
    const entrypoint = CURRENT_ENTRYPOINT_PATH;
    if (entrypoint === undefined)
      throw new Error("Missing current REA entrypoint");
    const alias = pathInside(workspace.root, "alias.mjs");
    await symlink(symlinkTarget(entrypoint), alias);
    await mkdir(pathInside(workspace.root, ".cursor"));
    const configPath = pathInside(workspace.root, ".cursor", "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          rea: { command: process.execPath, args: [alias, "mcp"] },
        },
      }),
    );
    const registrations = await readClientRegistrationStatuses(
      home,
      entrypoint,
      { environment: {} },
    );
    expect(registrations).toEqual([
      expect.objectContaining({ client: "cursor", state: "aligned" }),
    ]);
    const initialDoctor = await runDoctor(
      undefined,
      createDoctorHostFixture({
        clientRegistrations: async () => registrations,
      }),
    );
    expect(initialDoctor.identity?.registrations).toEqual([
      expect.objectContaining({ command_identity: "owned" }),
    ]);
    await rm(alias);
    const host = new FakeSetupHost();
    host.clients = [{ name: "cursor", configPath }];
    const discovery = await discoverSetupState({
      host,
      providerConfigured: true,
      forceHopperInstall: false,
      proposeHopper: false,
      initialDoctor,
    });
    expect(discovery.defaultClientIds).toEqual(["cursor"]);
    expect(discovery.clientStates).toEqual([
      expect.objectContaining({ configured: true, status: "configured" }),
    ]);
  },
);

it.each([
  {
    settings: { startup_timeout_sec: 0 },
    launcher: { command: "rea", args: ["mcp"] },
    state: "invalid",
    identity: "owned",
    status: "invalid",
  },
  {
    settings: {},
    launcher: { command: "./rea", args: ["mcp"] },
    state: "unknown",
    identity: "unknown",
    status: "unknown",
  },
  {
    settings: {},
    launcher: { command: "other", args: ["serve"] },
    state: "stale",
    identity: "foreign",
    status: "needs_configuration",
  },
] as const)(
  "keeps $identity launcher ownership separate from $state readiness",
  async ({ settings, launcher, state, identity, status }) => {
    const workspace = await createTestWorkspace("rea-plan-readiness-identity-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const home = pathInside(workspace.root, ".");
    const configPath = pathInside(workspace.root, ".cursor", "mcp.json");
    await mkdir(pathInside(workspace.root, ".cursor"));
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { rea: { ...launcher, ...settings } } }),
    );
    const registrations = await readClientRegistrationStatuses(
      home,
      undefined,
      { environment: {} },
    );
    expect(registrations).toEqual([
      expect.objectContaining({ state, command_identity: identity }),
    ]);
    const initialDoctor = await runDoctor(
      undefined,
      createDoctorHostFixture({
        clientRegistrations: async () => registrations,
      }),
    );
    const host = new FakeSetupHost();
    host.clients = [{ name: "cursor", configPath }];
    const discovery = await discoverSetupState({
      host,
      providerConfigured: true,
      forceHopperInstall: false,
      proposeHopper: false,
      initialDoctor,
    });
    expect(discovery.defaultClientIds).toEqual([]);
    expect(discovery.clientStates).toEqual([
      expect.objectContaining({ status, configured: false }),
    ]);
  },
);

it("offers detected missing and manual clients without treating absent launcher identity as unknown readiness", async () => {
  const workspace = await createTestWorkspace("rea-plan-absent-launcher-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const home = pathInside(workspace.root, ".");
  const configPath = pathInside(workspace.root, ".cursor", "mcp.json");
  await mkdir(pathInside(workspace.root, ".cursor"));
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }));
  const grokbotPath = pathInside(workspace.root, ".grokbot");
  await mkdir(grokbotPath);
  const registrations = await readClientRegistrationStatuses(home, undefined, {
    environment: {},
  });
  expect(registrations).toEqual([
    expect.objectContaining({
      client: "cursor",
      state: "missing",
      command_identity: "unknown",
    }),
    expect.objectContaining({
      client: "grok_bot",
      state: "manual",
      command_identity: "unknown",
    }),
  ]);
  const initialDoctor = await runDoctor(
    undefined,
    createDoctorHostFixture({ clientRegistrations: async () => registrations }),
  );
  const host = new FakeSetupHost();
  host.clients = [
    { name: "cursor", configPath },
    {
      name: "grok_bot",
      configPath: grokbotPath,
      format: "unsupported",
    },
  ];
  const discovery = await discoverSetupState({
    host,
    providerConfigured: true,
    forceHopperInstall: false,
    proposeHopper: false,
    initialDoctor,
  });
  expect(discovery.defaultClientIds).toEqual([]);
  expect(discovery.clientStates).toEqual([
    expect.objectContaining({
      client: { name: "cursor", configPath },
      status: "needs_configuration",
      configured: false,
    }),
    expect.objectContaining({
      client: host.clients[1],
      status: "needs_configuration",
      configured: false,
    }),
  ]);
});
