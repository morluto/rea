import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as processOutput from "../process/ExecFileOutput.js";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { ProcessAdmissionError } from "../process/ProcessAdmissionError.js";
import {
  createSystemProcessOwnershipHost,
  LinuxOwnedProcessPrerequisiteError,
  processOwnershipAdmissionRecovery,
} from "../process/ProcessOwnershipObservation.js";
import { ownedProcessPrerequisiteAvailability } from "./ownedProcessAvailability.js";

describe("Linux process table prerequisite discovery", () => {
  it.each(["ENOENT", "EACCES", "EIO"])(
    "reports %s with its own recovery",
    async (code) => {
      const cause = Object.assign(new Error(`ps failed: ${code}`), { code });
      const command = vi
        .spyOn(processOutput, "execFileOutput")
        .mockRejectedValue(cause);
      onTestFinished(() => command.mockRestore());
      const host = createSystemProcessOwnershipHost("linux", {});
      let failure: unknown;
      try {
        await host.prepare?.();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
      expect(failure).toMatchObject({
        cause,
        diagnostics: { system_code: code },
      });
      const availability = ownedProcessPrerequisiteAvailability(failure);
      expect(availability).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining(code),
        diagnostics: { system_code: code },
      });
      if (availability?.status !== "unavailable")
        throw new Error("expected unavailability");
      expect(availability.remediation).toContain(
        code === "ENOENT" ? "procps" : code,
      );
      if (code !== "ENOENT")
        expect(availability.remediation).not.toContain("Install");
    },
  );

  it("reports a ps probe failure with no error code without blaming missing procps", async () => {
    const cause = new Error("ps failed without error code");
    const command = vi
      .spyOn(processOutput, "execFileOutput")
      .mockRejectedValue(cause);
    onTestFinished(() => command.mockRestore());
    const host = createSystemProcessOwnershipHost("linux", {});
    let failure: unknown;
    try {
      await host.prepare?.();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
    expect(failure).toMatchObject({
      cause,
      reason: expect.stringContaining(
        "could not obtain the process table using ps: ps failed without error code",
      ),
    });
    const availability = ownedProcessPrerequisiteAvailability(failure);
    expect(availability).toMatchObject({
      status: "unavailable",
      code: "runtime_unavailable",
      remediation: processOwnershipAdmissionRecovery(
        "baseline_unavailable",
        "linux",
      ),
      diagnostics: {
        stage: "ownership_preparation",
        prerequisite_provider_id: "process-ownership",
        prerequisite_operation: "prepare_owned_process",
      },
    });
    if (availability?.status !== "unavailable")
      throw new Error("expected unavailability");
    expect(availability.diagnostics).not.toHaveProperty("system_code");
    expect(availability.remediation).not.toContain("procps");
    expect(availability.remediation).not.toContain("Install");
  });

  it("does not convert host spawn capacity exhaustion to unavailability", async () => {
    const cause = Object.assign(new Error("capacity"), { code: "EAGAIN" });
    const command = vi
      .spyOn(processOutput, "execFileOutput")
      .mockRejectedValue(cause);
    onTestFinished(() => command.mockRestore());
    const host = createSystemProcessOwnershipHost("linux", {});
    await expect(host.prepare?.()).rejects.toBe(cause);
  });
});

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
