import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWindowsShortcutService } from "../../../src/composition/binaryDiagnostics.js";
import { WindowsShortcutProvider } from "../../../src/native/windows/WindowsShortcutProvider.js";
import {
  LINK_FLAG,
  powershellHiddenIconSpoofShortcut,
  windowsShortcutBytes,
} from "../../fixtures/binaryDiagnostics/windowsShortcut.js";
import { phaseGate } from "../../support/lifecycleHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const { realpathCalls, lstatCalls, lstatGate } = vi.hoisted(() => ({
  realpathCalls: vi.fn(),
  lstatCalls: vi.fn(),
  // When set, the next lstat reports its path and waits for the gate.
  lstatGate: {} as {
    hold?: ((path: string) => Promise<void>) | undefined;
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: (async (...args: Parameters<typeof actual.realpath>) => {
      realpathCalls(...args);
      return actual.realpath(...args);
    }) as typeof actual.realpath,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      lstatCalls(String(args[0]));
      const hold = lstatGate.hold;
      if (hold !== undefined) {
        lstatGate.hold = undefined;
        await hold(String(args[0]));
      }
      return actual.lstat(...args);
    }) as typeof actual.lstat,
  };
});

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

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked shortcut without resolving its destination",
    async () => {
      const root = await createTestTempDirectory("rea-windows-shortcut-link-");
      const path = join(root, "shortcut.lnk");
      const alias = join(root, "alias.lnk");
      await writeFile(path, powershellHiddenIconSpoofShortcut());
      await symlink(path, alias);
      realpathCalls.mockClear();

      const result = await new WindowsShortcutProvider().inspect(
        providerInput(alias),
      );
      if (result.ok) throw new Error("Expected symlink rejection");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        issues: [{ path: ["path"], reason: "invalid_format" }],
      });
      expect(realpathCalls).not.toHaveBeenCalled();
    },
  );

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

  it("keeps a partial report when a LinkInfo offset points past the file", async () => {
    const root = await createTestTempDirectory("rea-windows-shortcut-offset-");
    const path = join(root, "shortcut.lnk");
    const bytes = windowsShortcutBytes({ idList: null });
    // LocalBasePathOffset sits 16 bytes into LinkInfo, which follows the header.
    bytes.writeUInt32LE(0xffffffff, 76 + 16);
    await writeFile(path, bytes);
    const result = await createWindowsShortcutService().inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      header: { header_size: 76 },
      coverage: { status: "partial", failing_offset: 92 },
    });
  });

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

it.each([
  { headerSize: 0x1c, status: "complete" },
  { headerSize: 0x1d, status: "partial" },
  { headerSize: 0x1e, status: "partial" },
  { headerSize: 0x1f, status: "partial" },
  { headerSize: 0x20, status: "partial" },
  { headerSize: 0x21, status: "partial" },
  { headerSize: 0x22, status: "partial" },
  { headerSize: 0x23, status: "partial" },
  { headerSize: 0x24, status: "complete" },
])(
  "reports LinkInfo header size $headerSize with $status coverage and retains following structures",
  async ({ headerSize, status }) => {
    const root = await createTestTempDirectory("rea-shortcut-linkinfo-header-");
    const path = join(root, "notes.lnk");
    const bytes = windowsShortcutBytes({
      flags: LINK_FLAG.HasLinkInfo | LINK_FLAG.HasName,
      unicode: false,
      idList: null,
      linkInfo: {
        unicode: headerSize !== 0x1c,
        localBasePath: "C:\\Notes",
        commonPathSuffix: "report.txt",
      },
      name: "Paper record",
      extraData: [],
    });
    // Vary only the declared size so the ANSI path fields retain valid offsets.
    bytes.writeUInt32LE(headerSize, 76 + 4);
    await writeFile(path, bytes);

    const result = await createWindowsShortcutService().inspect({ path });
    if (!result.ok) throw result.error;
    const malformed = status === "partial";
    expect(result.value.normalized_result).toMatchObject({
      link_info: {
        header_size: headerSize,
        local_base_path: "C:\\Notes",
        common_path_suffix: "report.txt",
        local_base_path_unicode: headerSize === 0x24 ? "C:\\Notes" : null,
      },
      string_data: { name: { value: "Paper record" } },
      extra_data: { terminal_offset: bytes.length - 4 },
      coverage: { status, failing_offset: malformed ? 80 : null },
      issues: malformed ? [{ code: "malformed_structure", offset: 80 }] : [],
    });
  },
);

it.each([false, true])(
  "reports an out-of-spec StringData count but retains following fields (Unicode: %s)",
  async (unicode) => {
    const root = await createTestTempDirectory("rea-shortcut-string-data-");
    const arguments_ = "a".repeat(400);
    const service = createWindowsShortcutService();
    for (const count of [260, 261]) {
      const path = join(root, `${count}.lnk`);
      const name = "n".repeat(count);
      const bytes = windowsShortcutBytes({
        unicode,
        idList: null,
        linkInfo: null,
        extraData: [],
        name,
        arguments: arguments_,
        iconLocation: "fixture.ico",
      });
      await writeFile(path, bytes);
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.normalized_result).toMatchObject({
        coverage: {
          status: count === 260 ? "complete" : "partial",
          failing_offset: count === 260 ? null : 76,
        },
        issues:
          count === 260
            ? []
            : [
                {
                  code: "malformed_structure",
                  offset: 76,
                  message: expect.stringContaining("NAME_STRING"),
                },
              ],
        string_data: {
          name: {
            value: name,
            count_characters: count,
            byte_length: count * (unicode ? 2 : 1),
          },
          arguments: { value: arguments_, count_characters: 400 },
          icon_location: { value: "fixture.ico" },
        },
        extra_data: { terminal_offset: bytes.length - 4 },
      });
    }
  },
);

it.each([
  {
    flags: 0x00001000,
    flagName: "HasDarwinID",
    blockName: "DarwinDataBlock",
    signature: 0xa0000006,
    size: 0x314,
  },
  {
    flags: 0x00020000,
    flagName: "RunWithShimLayer",
    blockName: "ShimDataBlock",
    signature: 0xa0000008,
    size: 0x88,
  },
])(
  "uses the ExtraData terminal to establish whether $blockName is absent",
  async ({ flags, flagName, blockName, signature, size }) => {
    const root = await createTestTempDirectory("rea-shortcut-extra-data-");
    const service = createWindowsShortcutService();
    const bytes = windowsShortcutBytes({
      flags,
      idList: null,
      linkInfo: null,
      extraData: [],
    });
    const terminalOffset = bytes.length - 4;
    const inspect = async (name: string, fixture: Buffer) => {
      const path = join(root, name);
      await writeFile(path, fixture);
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      return result.value.normalized_result;
    };

    expect(
      await inspect("incomplete.lnk", bytes.subarray(0, terminalOffset + 1)),
    ).toMatchObject({
      extra_data: { blocks: [], terminal_offset: null },
      coverage: { status: "partial", failing_offset: terminalOffset },
      issues: [{ code: "truncated", offset: terminalOffset }],
    });
    expect(await inspect("terminated.lnk", bytes)).toMatchObject({
      extra_data: { blocks: [], terminal_offset: terminalOffset },
      coverage: { status: "partial", failing_offset: terminalOffset },
      header: { link_flags: { decoded: [flagName] } },
      issues: [{ code: "missing_extra_data_block", offset: terminalOffset }],
    });

    const payload = Buffer.alloc(size - 8);
    payload.write("Fixture", 0, signature === 0xa0000006 ? "ascii" : "utf16le");
    const present = windowsShortcutBytes({
      flags,
      idList: null,
      linkInfo: null,
      extraData: [{ kind: "unknown", signature, payload }],
    });
    expect(await inspect("present.lnk", present)).toMatchObject({
      extra_data: {
        blocks: [{ signature, signature_name: blockName, size }],
        terminal_offset: present.length - 4,
      },
      coverage: { status: "complete" },
      issues: [],
    });
  },
);

describe("Windows shortcut parent directory links", () => {
  it.skipIf(process.platform === "win32")(
    "rejects a parent directory link before reading through it",
    async () => {
      const root = await createTestTempDirectory(
        "rea-windows-shortcut-parent-",
      );
      const real = join(root, "real");
      const linked = join(root, "linked");
      await mkdir(real);
      await writeFile(
        join(real, "shortcut.lnk"),
        powershellHiddenIconSpoofShortcut(),
      );
      await symlink(real, linked);
      const provider = new WindowsShortcutProvider("win32");

      const result = await provider.inspect(
        providerInput(join(linked, "shortcut.lnk")),
      );
      if (result.ok) throw new Error("Expected parent link rejection");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        issues: [
          {
            path: ["path"],
            reason: "invalid_value",
            observed: { linked_ancestor: linked },
          },
        ],
      });
      expect(
        await provider.inspect(providerInput(join(real, "shortcut.lnk"))),
      ).toMatchObject({ ok: true });
    },
  );

  it.skipIf(process.platform === "win32")(
    "admits the parent walk so close waits for it and a later call is refused",
    async () => {
      const root = await createTestTempDirectory(
        "rea-windows-shortcut-parent-close-",
      );
      const path = join(root, "shortcut.lnk");
      await writeFile(path, powershellHiddenIconSpoofShortcut());
      const provider = new WindowsShortcutProvider("win32");
      const parentWalk = phaseGate<string>();
      lstatGate.hold = (selected) => parentWalk.hold(selected);

      const inspecting = provider.inspect(providerInput(path));
      let closing: Promise<void> | undefined;
      try {
        await parentWalk.reached(inspecting, "parent walk lstat");
        let closed = false;
        closing = provider.close().then(() => {
          closed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(closed).toBe(false);
      } finally {
        lstatGate.hold = undefined;
        parentWalk.release();
        await inspecting;
        await closing;
      }

      const after = await provider.inspect(providerInput(path));
      if (after.ok) throw new Error("Expected a closed provider to refuse");
      expect(after.error._tag).not.toBe("AnalysisInputError");
    },
  );

  it("checks the caller's signal before walking parents", async () => {
    const root = await createTestTempDirectory(
      "rea-windows-shortcut-parent-abort-",
    );
    const path = join(root, "shortcut.lnk");
    await writeFile(path, powershellHiddenIconSpoofShortcut());
    const entered = vi.fn();
    lstatGate.hold = async (selected) => entered(selected);

    const result = await new WindowsShortcutProvider("win32").inspect(
      providerInput(path),
      { signal: AbortSignal.abort() },
    );
    lstatGate.hold = undefined;
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(entered).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "walks the parents Windows reaches after removing dot components",
    async () => {
      const root = await createTestTempDirectory(
        "rea-windows-shortcut-parent-dots-",
      );
      const real = join(root, "real");
      await mkdir(real);
      await writeFile(
        join(real, "shortcut.lnk"),
        powershellHiddenIconSpoofShortcut(),
      );
      // A sibling link, so the POSIX host's own `..` lands where Windows would.
      // The paths are spelled out, since `join` would remove the dots itself.
      await symlink(real, join(root, "alias"));
      const provider = new WindowsShortcutProvider("win32");

      expect(
        await provider.inspect(
          providerInput(`${root}/alias/../real/shortcut.lnk`),
        ),
      ).toMatchObject({ ok: true });
      expect(
        await provider.inspect(providerInput(`${root}/./alias/./shortcut.lnk`)),
      ).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisInputError",
          issues: [{ observed: { linked_ancestor: `${root}/alias` } }],
        },
      });
    },
  );

  it("starts the walk at the first parent of the effective Windows path", async () => {
    const provider = new WindowsShortcutProvider("win32");
    for (const [path, first] of [
      ["C:\\alias\\..\\real\\a.lnk", "C:\\real"],
      ["C:/alias/../real/a.lnk", "C:/real"],
      ["C:\\..\\.\\real\\a.lnk", "C:\\real"],
      ["\\\\.\\C:\\alias\\..\\real\\a.lnk", "\\\\.\\C:\\real"],
      ["\\\\?\\C:\\alias\\..\\real\\a.lnk", "\\\\?\\C:\\alias"],
      ["..\\real\\a.lnk", ".."],
    ] as const) {
      const entered = vi.fn();
      lstatGate.hold = async (selected) => entered(selected);
      await provider.inspect(providerInput(path));
      lstatGate.hold = undefined;
      expect(entered).toHaveBeenCalledWith(first);
    }
  });
});

describe("Windows shortcut deep parent paths", () => {
  it("stops a deep missing Windows path at its first unreadable parent", async () => {
    const provider = new WindowsShortcutProvider("win32");
    const path = `C:\\missing${"\\a".repeat(8_000)}\\a.lnk`;
    lstatCalls.mockClear();
    await provider.inspect(providerInput(path));
    expect(lstatCalls.mock.calls[0]).toEqual(["C:\\missing"]);
    expect(lstatCalls).not.toHaveBeenCalledWith("C:\\missing\\a");
  });
});
