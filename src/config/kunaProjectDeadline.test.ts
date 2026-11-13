import { expect, it } from "vitest";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import {
  kunaProjectDeadline,
  readKunaConfiguration,
} from "../kuna/KunaConfiguration.js";
import { acceptedExportDeadline } from "../kuna/KunaProjectExport.js";

it("keeps the deadline a failed export accepted after the override is reset", () => {
  const environment = {
    REA_KUNA_COMMAND: "/usr/bin/kuna",
    REA_KUNA_PROJECT_TIMEOUT_MS: "not-a-timeout",
  };
  const configuration = runWithAnalysisOperationSnapshot(
    {
      revision: 1,
      overrides: { "kuna.project_timeout_ms": 5000 },
    },
    () => {
      const parsed = readKunaConfiguration(environment, "linux");
      if (!parsed.ok) throw new Error(parsed.error.reason);
      return parsed.value;
    },
  );
  expect(configuration.projectTimeoutLaunchValid).toBe(false);
  const accepted = runWithAnalysisOperationSnapshot(
    {
      revision: 1,
      overrides: { "kuna.project_timeout_ms": 5000 },
    },
    () => kunaProjectDeadline(configuration),
  );
  expect(accepted).toEqual({
    setting: "REA_KUNA_PROJECT_TIMEOUT_MS",
    ms: 5000,
    source: "runtime",
  });
  expect(() => kunaProjectDeadline(configuration)).toThrow(
    /no runtime override is active/,
  );
  expect(acceptedExportDeadline(configuration, accepted)).toEqual(accepted);
  expect(accepted).toMatchObject({ ms: 5000, source: "runtime" });
});
