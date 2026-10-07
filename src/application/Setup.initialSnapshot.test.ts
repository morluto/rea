import { expect, it } from "vitest";

import { runSetup } from "./Setup.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";

it("uses the shared initial host snapshot for setup planning", async () => {
  const host = new FakeSetupHost();
  host.hopperPath = () => {
    throw new Error("setup snapshot should provide the Hopper path");
  };
  host.providerEnvironment = () => {
    throw new Error("setup snapshot should provide provider settings");
  };
  host.initialSetupState = async (scope) => ({
    hopperPath: "/snapshot/Hopper",
    providerEnvironment: { HOPPER_LAUNCHER_PATH: "/snapshot/Hopper" },
    doctor: await host.doctor(scope),
  });
  host.clients = [{ name: "codex", configPath: "/codex.json" }];

  const result = await runSetup(
    { ...options(false), dryRun: true, clientIds: ["codex"] },
    host,
  );

  expect(result.status).toBe("planned");
  expect(result.plannedActions.map(({ id }) => id)).toContain(
    "configure_client:codex",
  );
  expect(host.doctorCalls).toBe(1);
});

it("refreshes doctor after approved setup changes", async () => {
  const host = new FakeSetupHost();
  host.doctorHealthy = false;
  host.skill = "unchanged";
  host.clients = [{ name: "codex", configPath: "/codex.json" }];
  const configureClient = host.configureClient;
  host.configureClient = (client, providerEnvironment, command) => {
    host.doctorHealthy = true;
    return configureClient(client, providerEnvironment, command);
  };

  const result = await runSetup(
    { ...options(true), clientIds: ["codex"], installSkill: false },
    host,
  );

  expect(result.doctor.healthy).toBe(true);
  expect(host.doctorCalls).toBe(2);
});
