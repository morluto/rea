import { systemDoctorHost, type DoctorHost } from "./application/Doctor.js";
import { inspectSystemGhidraProvider } from "./ghidra/GhidraDoctor.js";

/** Compose provider diagnostics at the outer CLI adapter boundary. */
export const createSystemDoctorHost = (): DoctorHost =>
  systemDoctorHost({
    providerInspections: async () => [await inspectSystemGhidraProvider()],
  });
