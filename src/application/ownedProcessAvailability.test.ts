import { describe, expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { ProcessAdmissionError } from "../process/ProcessAdmissionError.js";
import { LinuxOwnedProcessPrerequisiteError } from "../process/ProcessOwnershipObservation.js";
import { ownedProcessPrerequisiteAvailability } from "./ownedProcessAvailability.js";

describe("Darwin ownership prerequisite discovery", () => {
  it("retains compiler diagnostics when a provider probe cannot prepare ownership", () => {
    const preparation = new DarwinProcessOwnershipInspectionError(
      "macOS process ownership helper compilation failed: missing DEVELOPER_DIR",
      {
        compilerOutcome: {
          outcome: "exited",
          code: 1,
          signal: null,
          stderr: "missing DEVELOPER_DIR",
          stderrTruncated: false,
          outputTruncated: false,
          killed: false,
        },
      },
    );
    const wrapped = new ProviderAdapterError(
      "apktool",
      "inspect_apktool_client",
      {
        cause: new OwnedCommandFailure(
          "process",
          "preparation failed",
          null,
          null,
          {
            preparationFailure: preparation,
          },
        ),
        diagnostics: { stage: "ownership_preparation" },
      },
    );
    expect(ownedProcessPrerequisiteAvailability(wrapped)).toMatchObject({
      status: "unavailable",
      code: "runtime_unavailable",
      reason: expect.stringContaining("missing DEVELOPER_DIR") as unknown,
      diagnostics: {
        stage: "ownership_preparation",
        compiler_outcome: { outcome: "exited", code: 1 },
      },
    });
  });

  it("does not downgrade cancellation, failed cleanup, or unrelated provider failures", () => {
    const preparation = new DarwinProcessOwnershipInspectionError(
      "compiler failed",
    );
    expect(
      ownedProcessPrerequisiteAvailability(new AnalysisCancelledError("probe")),
    ).toBeUndefined();
    expect(
      ownedProcessPrerequisiteAvailability(
        new ProviderAdapterError("apktool", "probe", {
          cause: preparation,
          diagnostics: { stage: "cleanup" },
        }),
      ),
    ).toBeUndefined();
    expect(
      ownedProcessPrerequisiteAvailability(
        new ProviderAdapterError("apktool", "probe", {
          cause: preparation,
          diagnostics: { stage: "ownership_preparation" },
          cleanup: { reason: "still owned", resources: ["helper"] },
        }),
      ),
    ).toBeUndefined();
    expect(
      ownedProcessPrerequisiteAvailability(
        new DarwinProcessOwnershipInspectionError("cancelled", {
          cancellation: { reason: "stop" },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("Linux ownership prerequisite discovery", () => {
  it("restricts procps/PATH remediation to missing ps and preserves system error codes", () => {
    const psMissing = new LinuxOwnedProcessPrerequisiteError(
      Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" }),
    );
    const wrappedMissing = new AnalysisCapabilityUnavailableError(
      "jadx",
      "inspect_jadx_client",
      "prerequisite failed",
      {
        cause: psMissing,
        diagnostics: { stage: "ownership_preparation" },
      },
    );
    expect(ownedProcessPrerequisiteAvailability(wrappedMissing)).toMatchObject({
      status: "unavailable",
      code: "runtime_unavailable",
      remediation: expect.stringContaining("procps"),
      diagnostics: {
        stage: "ownership_preparation",
        system_code: "ENOENT",
      },
    });

    const eioError = new LinuxOwnedProcessPrerequisiteError(
      Object.assign(new Error("ps EIO"), { code: "EIO" }),
      "EIO",
    );
    const wrappedEio = new AnalysisCapabilityUnavailableError(
      "jadx",
      "inspect_jadx_client",
      "prerequisite failed",
      {
        cause: eioError,
        diagnostics: { stage: "ownership_preparation" },
      },
    );
    const eioAvailability = ownedProcessPrerequisiteAvailability(wrappedEio);
    expect(eioAvailability).toMatchObject({
      status: "unavailable",
      code: "runtime_unavailable",
      remediation: expect.stringContaining("EIO"),
      diagnostics: {
        stage: "ownership_preparation",
        system_code: "EIO",
      },
    });
    expect(eioAvailability?.status).toBe("unavailable");
    if (eioAvailability?.status === "unavailable") {
      expect(eioAvailability.remediation).not.toContain("procps");
      expect(eioAvailability.remediation).not.toContain("PATH");
    }

    const unreported = new LinuxOwnedProcessPrerequisiteError(
      new ProcessAdmissionError("current_process_unreported"),
    );
    expect(ownedProcessPrerequisiteAvailability(unreported)).toMatchObject({
      status: "unavailable",
      code: "runtime_unavailable",
      remediation: expect.stringContaining("/proc or ps"),
      diagnostics: {
        stage: "ownership_preparation",
        admission_code: "current_process_unreported",
      },
    });
  });
});
