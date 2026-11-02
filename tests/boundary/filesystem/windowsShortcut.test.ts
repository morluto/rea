import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWindowsShortcutService } from "../../../src/composition/binaryDiagnostics.js";
import { WindowsShortcutProvider } from "../../../src/native/windows/WindowsShortcutProvider.js";
import { powershellHiddenIconSpoofShortcut } from "../../fixtures/binaryDiagnostics/windowsShortcut.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// The input schema admits Windows path forms only on a Windows host, so these
// reach the provider directly to run on every host.
const providerInput = (path: string) => ({
  path,
  max_file_bytes: 1048576,
  max_id_list_items: 256,
  max_extra_data_blocks: 64,
  max_string_bytes: 1048576,
});

describe("Windows shortcut stable filesystem boundary", () => {
  it("reports non-file and malformed Shell Link selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-windows-shortcut-files-");
    const path = join(root, "shortcut.lnk");
    const alias = join(root, "alias.lnk");
    const malformed = join(root, "malformed.lnk");
    await writeFile(path, powershellHiddenIconSpoofShortcut());
    await writeFile(malformed, Buffer.from("not a shell link"));
    await symlink(path, alias);
    const service = createWindowsShortcutService();
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [alias, "invalid_format"],
      [malformed, "invalid_format"],
      [join(root, "missing.lnk"), "invalid_value"],
      [join(path, "child.lnk"), "invalid_value"],
    ] as const) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected file acquisition failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_windows_shortcut",
        issues: [
          {
            path: ["path"],
            reason,
            message: expect.any(String),
          },
        ],
      });
    }
  });

  it("rejects network share paths without opening them", async () => {
    const provider = new WindowsShortcutProvider("win32");
    for (const path of [
      "\\\\server\\share\\shortcut.lnk",
      "//server/share/shortcut.lnk",
      "\\\\?\\UNC\\server\\share\\shortcut.lnk",
      "//./UNC/server/share/shortcut.lnk",
      "\\\\?\\GLOBALROOT\\Device\\Mup\\server\\share\\shortcut.lnk",
    ]) {
      const result = await provider.inspect(providerInput(path));
      if (result.ok) throw new Error("Expected network share rejection");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_windows_shortcut",
        issues: [
          {
            path: ["path"],
            reason: "invalid_value",
            message: expect.stringContaining("network share"),
          },
        ],
      });
    }
  });

  it("does not treat an extended drive path as a network share", async () => {
    const provider = new WindowsShortcutProvider("win32");
    for (const path of [
      "\\\\?\\C:\\shortcuts\\missing.lnk",
      "\\\\.\\C:\\shortcuts\\missing.lnk",
    ]) {
      const result = await provider.inspect(providerInput(path));
      if (result.ok) throw new Error("Expected a missing file");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        issues: [
          {
            path: ["path"],
            message: expect.not.stringContaining("network share"),
          },
        ],
      });
    }
  });

  it.skipIf(process.platform === "win32")(
    "reads repeated leading slashes as a local POSIX path",
    async () => {
      const root = await createTestTempDirectory("rea-windows-shortcut-posix-");
      const path = join(root, "shortcut.lnk");
      await writeFile(path, powershellHiddenIconSpoofShortcut());

      const result = await new WindowsShortcutProvider("linux").inspect(
        providerInput(`//${path}`),
      );
      expect(result.ok).toBe(true);
    },
  );

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-windows-shortcut-budget-");
    const path = join(root, "shortcut.lnk");
    await writeFile(path, powershellHiddenIconSpoofShortcut());
    const service = createWindowsShortcutService();
    const tooSmall = await service.inspect({ path, max_file_bytes: 76 });
    if (tooSmall.ok) throw new Error("Expected resource budget failure");
    expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
    const items = await service.inspect({ path, max_id_list_items: 1 });
    if (items.ok) throw new Error("Expected IDList budget failure");
    expect(items.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      reportedLimits: { boundary: "id_list_items", maximum: 1 },
      remediationAction: expect.stringContaining("max_id_list_items"),
      retryable: false,
    });
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });
});
