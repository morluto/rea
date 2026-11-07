import { describe, expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import {
  createSystemProcessOwnershipHost,
  LinuxOwnedProcessPrerequisiteError,
} from "../process/ProcessOwnershipObservation.js";
import { ownedProcessPrerequisiteAvailability } from "./ownedProcessAvailability.js";

describe("Linux process table prerequisite discovery", () => {
  it.each(["ENOENT", "EACCES", "EIO"])(
    "reports %s with its own recovery",
    async (code) => {
      const cause = Object.assign(new Error(`ps failed: ${code}`), { code });
      const host = createSystemProcessOwnershipHost(
        "linux",
        {},
        {
          execFileOutput: async () => {
            throw cause;
          },
        },
      );
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
      expect(availability?.remediation).toContain(
        code === "ENOENT" ? "procps" : code,
      );
      if (code !== "ENOENT")
        expect(availability?.remediation).not.toContain("Install");
    },
  );

  it("does not convert host spawn capacity exhaustion to unavailability", async () => {
    const cause = Object.assign(new Error("capacity"), { code: "EAGAIN" });
    const host = createSystemProcessOwnershipHost(
      "linux",
      {},
      {
        execFileOutput: async () => {
          throw cause;
        },
      },
    );
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
