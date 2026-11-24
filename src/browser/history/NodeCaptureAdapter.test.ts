import { expect, it } from "vitest";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { NodeCaptureAdapter } from "./NodeCaptureAdapter.js";

it.each(["har", "qlog"] as const)(
  "keeps SAZ-specific limitations out of %s captures",
  (format) => {
    expect(new NodeCaptureAdapter(format).limitations).toEqual([]);
  },
);

it.each(["saz", "qlog"] as const)(
  "uses an enforceable memory bound for %s on the current runtime",
  async (format) => {
    const adapter = new NodeCaptureAdapter(format);
    const bun = process.versions.bun !== undefined;
    if (bun && process.platform !== "win32") {
      await expect(
        adapter.command("/owned/request.json"),
      ).rejects.toBeInstanceOf(AnalysisCapabilityUnavailableError);
    } else {
      const command = await adapter.command("/owned/request.json");
      expect(command.command).toBe(process.execPath);
      if (bun) expect(command.memoryLimitBytes).toBeGreaterThan(0);
      else expect(command.memoryLimitBytes).toBeUndefined();
    }
  },
);
