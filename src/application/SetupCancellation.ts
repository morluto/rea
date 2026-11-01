import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { SetupHost } from "./SetupTypes.js";

export const throwIfSetupCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted)
    throw new AnalysisCancelledError("setup", { cause: signal.reason });
};

/** Finish admitted transactions, but never admit later work after cancellation. */
export const withSetupCancellation = (
  host: SetupHost,
  signal?: AbortSignal,
): SetupHost => {
  if (signal === undefined) return host;
  const guard =
    <Arguments extends readonly unknown[], Value>(
      action: (...args: Arguments) => Promise<Value>,
    ) =>
    async (...args: Arguments): Promise<Value> => {
      throwIfSetupCancelled(signal);
      const value = await action(...args);
      throwIfSetupCancelled(signal);
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
    installHopper: guard(host.installHopper.bind(host)),
    detectedClients: guard(host.detectedClients.bind(host)),
    supportedClients: guard(host.supportedClients.bind(host)),
    configureClient: guard(host.configureClient.bind(host)),
    clientNeedsConfigure: guard(host.clientNeedsConfigure.bind(host)),
    inspectClientConfiguration: guard(
      host.inspectClientConfiguration.bind(host),
    ),
    skillNeedsInstall: guard(host.skillNeedsInstall.bind(host)),
    validateSkillDirectories: guard(host.validateSkillDirectories.bind(host)),
    installSkill: guard(host.installSkill.bind(host)),
    doctor: guard(host.doctor.bind(host)),
  };
};
