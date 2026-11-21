import { inspectAnalysisSettingSeeds } from "../config/analysisSettings.js";
import {
  parseEnvironment,
  parseEnvironmentValues,
  type Environment,
} from "../config/environment.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";

/** Validate literal registration settings while retaining expression-owned unknowns. */
export const validateRegistrationEnvironment = (
  values: Readonly<Record<string, string>>,
  expressionSettings: ReadonlySet<string>,
  validation: "fragment" | "effective",
  platform: NodeJS.Platform,
): Result<
  {
    readonly configuration: Environment;
    readonly unresolvedSettings: ReadonlySet<string>;
  },
  ConfigurationError
> => {
  const runtimeEnvironment = snapshotEnvironment(values, platform);
  const unresolvedSettings = new Set(
    Object.keys(
      snapshotEnvironment(
        Object.fromEntries([...expressionSettings].map((name) => [name, ""])),
        platform,
      ),
    ),
  );
  const validated =
    validation === "fragment"
      ? parseEnvironmentValues(runtimeEnvironment, unresolvedSettings)
      : parseEnvironment(runtimeEnvironment, unresolvedSettings);
  if (!validated.ok) return validated;
  const seedIssues = inspectAnalysisSettingSeeds(
    runtimeEnvironment,
    unresolvedSettings,
  );
  if (seedIssues.length > 0)
    return err(
      new ConfigurationError("Invalid REA environment configuration", {
        settings: seedIssues,
      }),
    );
  return ok({ configuration: validated.value, unresolvedSettings });
};
