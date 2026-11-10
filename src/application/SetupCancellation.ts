import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { SetupHost } from "./SetupTypes.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { SetupSkillInstallError } from "./SetupSkill.js";

/** Setup effect results contain caller-visible recovery facts, never ambient state. */
export const setupOutcomeSnapshot = (value: unknown): JsonValue =>
  jsonValueSchema.parse(
    JSON.parse(
      JSON.stringify(value, (_key, entry: unknown) =>
        entry instanceof SetupSkillInstallError
          ? {
              name: entry.name,
              message: entry.message,
              path: entry.path,
              stage: entry.stage,
              reason: entry.reason,
              rollbackFailures: entry.rollbackFailures,
              recoveryBackupPaths: entry.recoveryBackupPaths,
              remediation: entry.remediationAction,
            }
          : entry instanceof Error
            ? { ...entry, name: entry.name, message: entry.message }
            : entry,
      ),
    ),
  );

export const throwIfSetupCancelled = (signal?: AbortSignal): void => {
  assertSetupActive(signal);
};

/**
 * Finish admitted transactions, but never admit later work after cancellation.
 * A settled effect is returned, not discarded, so the workflow can record its
 * outcome before it observes the cancellation.
 */
export const withSetupCancellation = (
  host: SetupHost,
  signal?: AbortSignal,
  recordEffect: (operation: string, result: JsonValue) => void = () => {},
): SetupHost => {
  if (signal === undefined) return host;
  const guard =
    <Arguments extends readonly unknown[], Value>(
      action: (...args: Arguments) => Promise<Value>,
      operation?: string,
    ) =>
    async (...args: Arguments): Promise<Value> => {
      throwIfSetupCancelled(signal);
      const value = await action(...args);
      if (operation !== undefined)
        recordEffect(operation, setupOutcomeSnapshot(value));
      return value;
    };
  return {
    ...host,
    skillDestinations: host.skillDestinations.bind(host),
    ...(host.close === undefined ? {} : { close: host.close.bind(host) }),
    ...(host.clientSetupAction === undefined
      ? {}
      : { clientSetupAction: host.clientSetupAction.bind(host) }),
    ...(host.prepareClientSetup === undefined
      ? {}
      : { prepareClientSetup: host.prepareClientSetup.bind(host) }),
    macosVersion: guard(host.macosVersion.bind(host)),
    linuxDistribution: guard(host.linuxDistribution.bind(host)),
    initialSetupState: guard(host.initialSetupState.bind(host)),
    installHopper: guard(host.installHopper.bind(host), "install_hopper"),
    detectedClients: guard(host.detectedClients.bind(host)),
    supportedClients: guard(host.supportedClients.bind(host)),
    configureClient: async (...args) => {
      throwIfSetupCancelled(signal);
      const value = await host.configureClient(...args);
      recordEffect(
        `configure_client:${args[0].name}`,
        setupOutcomeSnapshot(value),
      );
      return value;
    },
    clientNeedsConfigure: guard(host.clientNeedsConfigure.bind(host)),
    inspectClientConfiguration: guard(
      host.inspectClientConfiguration.bind(host),
    ),
    skillNeedsInstall: guard(host.skillNeedsInstall.bind(host)),
    validateSkillDirectories: guard(host.validateSkillDirectories.bind(host)),
    installSkill: guard(host.installSkill.bind(host), "install_skill"),
    doctor: guard(host.doctor.bind(host)),
  };
};

/** Preserve the caller's exact reason while setup unwinds its resource owners. */
export const assertSetupActive = (
  signal?: AbortSignal,
  failure?: string,
): void => {
  if (signal?.aborted)
    throw new AnalysisCancelledError("setup", {
      cause: signal.reason,
      ...(failure === undefined
        ? {}
        : { diagnostics: { setup_failure: failure } }),
    });
};
