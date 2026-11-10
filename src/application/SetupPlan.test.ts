import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import { runDoctor } from "./Doctor.js";
import { createDoctorHostFixture } from "./Doctor.fixture.js";
import { FakeSetupHost } from "./Setup.fixture.js";
import { readClientRegistrationStatuses } from "./ClientRegistrationStatus.js";
import { discoverSetupState } from "./SetupPlan.js";

it.skipIf(process.platform === "win32")(
  "retains doctor ownership observations when a launcher alias becomes unavailable before discovery",
  async () => {
    const home = await createTestTempDirectory("rea-plan-command-identity-");
    const entrypoint = CURRENT_ENTRYPOINT_PATH;
    if (entrypoint === undefined)
      throw new Error("Missing current REA entrypoint");
    const alias = join(home, "alias.mjs");
    await symlink(entrypoint, alias);
    await mkdir(join(home, ".cursor"));
    await writeFile(
      join(home, ".cursor", "mcp.json"),
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
    host.clients = [
      { name: "cursor", configPath: join(home, ".cursor", "mcp.json") },
    ];
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
    const home = await createTestTempDirectory("rea-plan-readiness-identity-");
    const configPath = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
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
  const home = await createTestTempDirectory("rea-plan-absent-launcher-");
  const configPath = join(home, ".cursor", "mcp.json");
  await mkdir(join(home, ".cursor"));
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }));
  await mkdir(join(home, ".grokbot"));
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
      configPath: join(home, ".grokbot"),
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
