import { expect, it } from "vitest";

import { processScenarioSchema } from "../../domain/process/processScenario.js";
import {
  makePtyProcessCaptureEnvironment,
  resolvePtyProcessLaunch,
} from "./ProcessPtyLaunch.js";

it("delegates __proto__ through env and drops it from the PTY env object", () => {
  const scenario = processScenarioSchema.parse({
    executable: "/usr/bin/node",
    arguments: ["-e", "console.log(process.version)"],
    environment: {
      ["__proto__"]: "selected-value",
      NORMAL_CAPTURE_KEY: "control-value",
    },
  });
  expect(resolvePtyProcessLaunch(scenario)).toEqual({
    executable: "/usr/bin/env",
    arguments: [
      "__proto__=selected-value",
      "/usr/bin/node",
      "-e",
      "console.log(process.version)",
    ],
    environmentDelegateNames: ["__proto__"],
  });
  expect(
    makePtyProcessCaptureEnvironment(
      {
        scenario,
        hostEnvironment: { NORMAL_CAPTURE_KEY: "host-value" },
        runId: "capture-token",
        platform: "linux",
      },
      ["__proto__"],
    ),
  ).toEqual({
    NORMAL_CAPTURE_KEY: "control-value",
    TERM: "xterm-256color",
    REA_PROCESS_RUN_ID: "capture-token",
  });
});

it("keeps the original launch shape when no PTY-delegated names are present", () => {
  const scenario = processScenarioSchema.parse({
    executable: "/bin/true",
    environment: { NORMAL_CAPTURE_KEY: "control-value" },
  });
  expect(resolvePtyProcessLaunch(scenario)).toEqual({
    executable: "/bin/true",
    arguments: [],
    environmentDelegateNames: [],
  });
});
