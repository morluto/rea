import {
  systemDoctorHost,
  type DoctorCheck,
  type DoctorHost,
} from "./application/Doctor.js";
import { inspectSystemGhidraProvider } from "./ghidra/GhidraDoctor.js";
import { parseConfig } from "./config.js";
import { SystemJavaScriptReplayHost } from "./replay/SystemJavaScriptReplayHost.js";

/** Compose provider diagnostics at the outer CLI adapter boundary. */
export const createSystemDoctorHost = (): DoctorHost =>
  systemDoctorHost({
    providerInspections: async () => [await inspectSystemGhidraProvider()],
    javascriptReplayCheck: inspectJavaScriptReplay,
  });

const inspectJavaScriptReplay = async (): Promise<DoctorCheck> => {
  const config = parseConfig(process.env);
  if (!config.ok)
    return {
      name: "javascript-replay",
      ok: false,
      classification: "config_drift",
      detail: config.error.message,
      remediation: "Fix the reported REA_JAVASCRIPT_REPLAY_* configuration.",
    };
  if (!config.value.javascriptReplayPolicy.enabled)
    return {
      name: "javascript-replay",
      ok: true,
      classification: "healthy",
      detail:
        "disabled by default; no extracted-module execution path is admitted",
    };
  try {
    await new SystemJavaScriptReplayHost().probe(
      config.value.javascriptReplayPolicy,
    );
    return {
      name: "javascript-replay",
      ok: true,
      classification: "healthy",
      detail: "Linux namespace, seccomp, and delegated cgroup probes passed",
    };
  } catch (cause: unknown) {
    return {
      name: "javascript-replay",
      ok: false,
      classification:
        process.platform === "linux"
          ? "missing_dependency"
          : "unsupported_host",
      detail: cause instanceof Error ? cause.message : "sandbox probe failed",
      remediation:
        "Install and configure compatible Bubblewrap and systemd user cgroup delegation, or disable controlled replay.",
    };
  }
};
