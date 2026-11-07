import { describe, expect, it } from "vitest";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const analyze = (source: string, path: string) => {
  const parsed = parseJavaScriptSource(source, path);
  if (parsed === null) throw new Error("fixture did not parse");
  return analyzeParsedJavaScriptStaticSource(source, parsed);
};

describe("conditional Electron identities", () => {
  const source = `
    const electron = require("electron");
    const { BrowserWindow, protocol } = electron;
    new BrowserWindow({ webPreferences: { sandbox: false } });
    protocol.handle("app", handler);
  `;

  it("retains alias-derived findings without proving an unknown loader", () => {
    const result = analyze(source, "main.MJS");
    expect(result.analysis_coverage?.applicability.electron).toBe("unknown");
    expect(result.electron.browser_windows).toMatchObject([
      {
        loader_authority: "candidate",
        web_preferences: [
          { name: "sandbox", value: { status: "literal", value: false } },
        ],
      },
    ]);
    expect(result.electron.protocols).toMatchObject([
      {
        loader_authority: "candidate",
        api: "handle",
        scheme: { status: "literal", value: "app" },
      },
    ]);
    expect(result.limitations).toContain(
      "Some Electron syntax depends on an unproved CommonJS loader; its Electron identity remains conditional.",
    );
  });

  it("retains established CommonJS and ES module observations as proven", () => {
    const commonjs = analyze(source, "main.cjs");
    expect(commonjs.analysis_coverage?.applicability.electron).toBe("observed");
    expect(
      commonjs.electron.browser_windows[0]?.loader_authority,
    ).toBeUndefined();
    const esm = analyze(
      'import { BrowserWindow } from "electron"; new BrowserWindow({});',
      "main.mjs",
    );
    expect(esm.analysis_coverage?.applicability.electron).toBe("observed");
    expect(esm.electron.browser_windows[0]?.loader_authority).toBeUndefined();
  });

  it("retains optional loader findings with the host's authority", () => {
    const optional = 'const {app, BrowserWindow} = require?.("electron"); app.setAppPath("/tmp"); new BrowserWindow();';
    const candidate = analyze(optional, "main.MJS");
    expect(candidate.analysis_coverage?.applicability.electron).toBe("unknown");
    expect(candidate.electron.browser_windows).toMatchObject([{ loader_authority: "candidate" }]);
    expect(candidate.electron.app_path_changes).toMatchObject([{ loader_authority: "candidate" }]);
    const commonjs = analyze(optional, "main.cjs");
    expect(commonjs.electron.browser_windows).toHaveLength(1);
    expect(commonjs.electron.browser_windows[0]?.loader_authority).toBeUndefined();
    expect(commonjs.electron.app_path_changes).toHaveLength(1);
    expect(commonjs.electron.app_path_changes?.[0]?.loader_authority).toBeUndefined();
  });

  it("does not claim conditional identity when initialization is skipped or loader is shadowed", () => {
    const skipped = analyze(
      'while (false) { var electron = require("electron"); } new electron.BrowserWindow({});',
      "main.MJS",
    );
    expect(skipped.electron.browser_windows).toEqual([]);
    const shadowed = analyze(
      'const require = () => ({ BrowserWindow: Local }); const { BrowserWindow } = require("electron"); new BrowserWindow({});',
      "main.MJS",
    );
    expect(shadowed.electron.browser_windows).toEqual([]);
  });
});
