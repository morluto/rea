import { describe, expect, it } from "vitest";
import { NativeModuleResolver } from "./NativeModuleResolver.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";

const input = {
  importerUrl: "https://app.test/main.js",
  importMap: null,
  specifiers: ["./dep.js"],
};
describe("optional native resolution acquisition", () => {
  it("awaits owned cleanup when cancellation arrives during acquisition", async () => {
    const controller = new AbortController();
    let closed = false;
    const provider = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/browser" },
      () => {
        controller.abort();
        return Promise.resolve({
          version: () => "fixture",
          newContext: () => {
            throw new Error("must not acquire context");
          },
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        });
      },
    );
    const result = await provider.resolve(input, { signal: controller.signal });
    expect(closed).toBe(true);
    if (result.ok) throw new Error("expected cancelled result");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });
  it("returns cleanup_incomplete when owned cleanup fails after an engine error", async () => {
    const provider = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/browser" },
      () =>
        Promise.resolve({
          version: () => "fixture",
          newContext: () =>
            Promise.reject(new Error("fixture context failure")),
          close: () =>
            Promise.reject(new Error("fixture owned cleanup refusal")),
        }),
    );
    const result = await provider.resolve(input);
    if (result.ok) throw new Error("expected cleanup failure");
    expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
    expect(result.error.cleanupIncomplete).toBe(true);
  });
  it("does not load the browser engine when the selected operation lacks its configuration", async () => {
    const provider = new NativeModuleResolver({}, () => {
      throw new Error("must not launch");
    });
    const result = await provider.resolve(input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "capability_unavailable",
        message: expect.stringContaining("REA_BROWSER_EXECUTABLE"),
      });
  });
  it("does not acquire a browser after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/browser" },
      () => {
        throw new Error("must not launch");
      },
    );
    const result = await provider.resolve(input, { signal: controller.signal });
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });
  it("retains the selected executable and actual startup diagnostic", async () => {
    const provider = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/missing/browser" },
      () => Promise.reject(new Error("spawn EACCES fixture")),
    );
    const result = await provider.resolve(input);
    if (result.ok) throw new Error("expected startup failure");
    expect(projectAnalysisError(result.error).details).toMatchObject({
      diagnostics: {
        executable: "/missing/browser",
        error_message: "spawn EACCES fixture",
      },
    });
  });
});
