import { expect, it } from "vitest";

import { runSetup } from "./Setup.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";
import { supportedClientRegistrationProfile } from "./SupportedClients.js";

it("refreshes doctor after approved setup changes", async () => {
  const host = new FakeSetupHost();
  host.doctorHealthy = false;
  host.skill = "unchanged";
  host.clients = [
    {
      name: "codex",
      registrationProfile: supportedClientRegistrationProfile("codex"),
      configPath: "/codex.json",
    },
  ];
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
});
