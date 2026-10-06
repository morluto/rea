import {
  systemDoctorHost,
  type DoctorCheck,
  type DoctorHost,
} from "./application/Doctor.js";
import { fileURLToPath } from "node:url";
import { inspectSystemGhidraProvider } from "./ghidra/GhidraDoctor.js";
import { inspectSystemBinaryNinjaProvider } from "./binaryNinja/BinaryNinjaDoctor.js";
import { inspectIdaRegistration } from "./ida/IdaDoctor.js";
import { selectLinuxPrivateDisplayStrategy } from "./hopper/LinuxPrivateDisplayProbe.js";

/** Compose provider diagnostics at the outer CLI adapter boundary. */
export const createSystemDoctorHost = (): DoctorHost =>
  systemDoctorHost({
    providerInspections: () =>
      Promise.all([
        inspectSystemGhidraProvider(),
        inspectSystemBinaryNinjaProvider(),
        inspectIdaRegistration(process.env.REA_IDA_MCP_CONFIG),
      ]),
    linuxDemoRuntimeCheck: inspectLinuxPrivateDisplay,
  });

const HOPPER_DEMO_HELPER_PATH = fileURLToPath(
  new URL("../scripts/hopper-demo-x11.py", import.meta.url),
);

const inspectLinuxPrivateDisplay = async (): Promise<DoctorCheck> => {
  const selection = await selectLinuxPrivateDisplayStrategy({
    helperPath: HOPPER_DEMO_HELPER_PATH,
  });
  const value = selection.diagnostic;
  const detail = [
    `strategy=${selection.strategy}`,
    `socket_directory=${value.socket_directory}`,
    `mode=${value.socket_directory_mode ?? "unknown"}`,
    `mount_read_only=${String(value.mount_read_only)}`,
    `effective_mode=${value.effective_socket_directory_mode ?? "unknown"}`,
    `effective_mount_read_only=${String(value.effective_mount_read_only)}`,
    `wsl=${String(value.wsl)}`,
  ].join("; ");
  if (selection.ok)
    return {
      name: "hopper-demo-runtime",
      ok: true,
      classification: "healthy",
      detail,
      details: { private_display: { ...value } },
    };
  const missingDependency =
    value.failure_code === "runtime_dependency_unavailable" ||
    value.failure_code === "x11_authorization_failed";
  return {
    name: "hopper-demo-runtime",
    ok: false,
    classification: missingDependency ? "missing_dependency" : "config_drift",
    detail,
    details: { private_display: { ...value } },
    remediation:
      value.failure_code === "x11_socket_directory_unusable"
        ? "Enable unprivileged user and mount namespaces, or provide a writable mode-1777 /tmp/.X11-unix directory. Do not mutate the current host mount with sudo; then rerun rea doctor --provider hopper."
        : missingDependency
          ? "Install Xvfb, xauth, Python 3, libX11, and libXtst, then rerun rea doctor --provider hopper."
          : "Inspect the private-display diagnostic, correct the reported local condition, and rerun rea doctor --provider hopper.",
  };
};
