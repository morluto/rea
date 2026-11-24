import * as fs from "node:fs/promises";
import { appendFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  LEGACY_PROTOCOL_REMOVED,
  readIdaConfiguration,
} from "./IdaConfiguration.js";
import type { RetainedResourceScope } from "../ports/AnalysisProvider.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import * as regularFile from "../filesystem/RegularFile.js";

vi.mock("node:fs/promises", { spy: true });

const resourceScope: RetainedResourceScope = {
  retain: () => undefined,
  run: (operation) => operation(),
};
/** An attached registration names its upstream protocol. */
const ATTACHED_REGISTRATION = JSON.stringify({
  command: "python",
  protocol: "native",
});
const read = (path: string) => readIdaConfiguration(path, { resourceScope });

describe("IDA registration and MCP result boundaries", () => {
  it("reuses a direct or upstream mcpServers registration with no installation", async () => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    for (const input of [
      { command: "python", args: ["server.py"], protocol: "native" },
      {
        mcpServers: {
          "ida-pro-mcp": {
            command: "python",
            args: ["server.py"],
            protocol: "native",
          },
          unrelated: { command: "untouched" },
        },
      },
    ]) {
      await writeFile(path, JSON.stringify(input));
      expect(await read(path)).toMatchObject({
        ok: true,
        value: {
          command: "python",
          args: ["server.py"],
          mode: "attached",
          protocol: "native",
        },
      });
    }
  });

  it("validates local transport and lifecycle inputs and retains selected HTTP credentials", async () => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    for (const input of [
      { url: "https://example.com/mcp" },
      { url: "http://token@127.0.0.1/mcp" },
      { url: "http://token@host.docker.internal:13337/mcp" },
      { url: "http://host.docker.internal.example.com/mcp" },
      { url: "ftp://host.docker.internal/mcp" },
      { command: "python", mode: "force_gui" },
      { command: "python", workspaceRoot: "relative" },
      { command: "python", args: "server.py" },
    ]) {
      await writeFile(path, JSON.stringify({ ...input, protocol: "native" }));
      expect((await read(path)).ok).toBe(false);
    }
    await writeFile(
      path,
      JSON.stringify({
        url: "http://127.0.0.1:8745/mcp",
        mode: "headless",
        headers: { Authorization: "Bearer fixture-secret" },
      }),
    );
    expect(await read(path)).toMatchObject({
      ok: true,
      value: { headers: { Authorization: "Bearer fixture-secret" } },
    });
    for (const url of [
      "http://host.docker.internal:13337/mcp",
      "http://HOST.CONTAINERS.INTERNAL:13337/mcp",
    ]) {
      await writeFile(path, JSON.stringify({ url, protocol: "native" }));
      expect(await read(path)).toMatchObject({ ok: true, value: { url } });
    }
    await writeFile(path, "malformed");
    expect((await read(path)).ok).toBe(false);
    expect((await read(join(root, "absent"))).ok).toBe(false);
    const registration = ATTACHED_REGISTRATION;
    await writeFile(path, registration.padEnd(65_536));
    expect((await read(path)).ok).toBe(true);
    await writeFile(path, registration.padEnd(65_537));
    expect(await read(path)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("64 KiB") },
    });
  });
});

it("rejects registration growth beyond the byte limit after descriptor admission", async () => {
  const root = await createTestTempDirectory("rea-ida-config-");
  const path = join(root, "mcp.json");
  await writeFile(path, ATTACHED_REGISTRATION);
  const openRegularFile = regularFile.openRegularFile;
  const admission = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementation(async (...args) => {
      const source = await openRegularFile(...args);
      await appendFile(path, " ".repeat(65_536));
      return source;
    });
  try {
    expect(await read(path)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("64 KiB") },
    });
  } finally {
    admission.mockRestore();
  }
});

it.each([
  ["admission", "denied"],
  ["growth", "denied"],
  ["admission", "cancelled"],
  ["admission", "cancelled-and-denied"],
] as const)(
  "keeps the 64 KiB rejection from the %s size check through a %s close",
  async (branch, closeOutcome) => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    await writeFile(
      path,
      branch === "admission"
        ? ATTACHED_REGISTRATION.padEnd(65_537)
        : ATTACHED_REGISTRATION,
    );
    const retained: { close(): Promise<void> }[] = [];
    const owner: RetainedResourceScope = {
      retain: (resource) => retained.push(resource),
      run: (operation) => operation(),
    };
    const openRegularFile = regularFile.openRegularFile;
    const admission =
      branch === "growth"
        ? vi
            .spyOn(regularFile, "openRegularFile")
            .mockImplementation(async (...args) => {
              const source = await openRegularFile(...args);
              await appendFile(path, " ".repeat(65_536));
              return source;
            })
        : undefined;
    const controller = new AbortController();
    const reason = new Error("cancel while closing the oversized registration");
    const close = OwnedFileHandle.prototype.close;
    const denial = new Error("descriptor close denied");
    const closeSpy = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementationOnce(function (this: OwnedFileHandle) {
        if (closeOutcome !== "denied") controller.abort(reason);
        return closeOutcome === "cancelled"
          ? close.call(this)
          : Promise.reject(denial);
      });
    try {
      const result = await readIdaConfiguration(path, {
        resourceScope: owner,
        signal: controller.signal,
      });
      if (result.ok) throw new Error("expected the size rejection");
      expect(result.error.message).toContain("64 KiB");
      if (closeOutcome !== "denied") {
        expect(result.error.secondaryFailures).toEqual([
          expect.objectContaining({
            _tag: "AnalysisCancelledError",
            cause: reason,
          }),
        ]);
      }
      if (closeOutcome === "cancelled") {
        expect(result.error.cleanupIncomplete).toBe(false);
        expect(retained).toHaveLength(0);
      } else {
        expect(result.error.cleanup).toMatchObject({
          reason: expect.stringContaining("descriptor close denied"),
          resources: [path],
        });
        expect(result.error.cleanupIncomplete).toBe(true);
        expect(retained).toHaveLength(1);
        await rm(path);
        await retained[0]!.close();
        expect(result.error.cleanupIncomplete).toBe(false);
      }
    } finally {
      admission?.mockRestore();
      closeSpy.mockRestore();
    }
  },
);

describe("IDA registration descriptor ownership", () => {
  it("retains the exact descriptor after close denial and resolves its error only after retry", async () => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    await writeFile(path, ATTACHED_REGISTRATION);
    const retained: { close(): Promise<void> }[] = [];
    const owner: RetainedResourceScope = {
      retain: (resource) => retained.push(resource),
      run: (operation) => operation(),
    };
    const close = OwnedFileHandle.prototype.close;
    let denied = false;
    const denial = new Error("descriptor close denied");
    const closeSpy = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(function (this: OwnedFileHandle) {
        if (!denied) {
          denied = true;
          return Promise.reject(denial);
        }
        return close.call(this);
      });
    try {
      const result = await readIdaConfiguration(path, {
        resourceScope: owner,
      });
      if (result.ok) throw new Error("expected close failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(retained).toHaveLength(1);
      await rm(path);
      await retained[0]!.close();
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      closeSpy.mockRestore();
    }
  });
  it("preserves the caller's exact cancellation reason", async () => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    await writeFile(path, ATTACHED_REGISTRATION);
    const reason = new Error("stop registration inspection");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(
      readIdaConfiguration(path, {
        resourceScope,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisCancelledError", cause: reason });
  });
  it("preserves post-open cancellation when the descriptor's final close is denied", async () => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    await writeFile(path, ATTACHED_REGISTRATION);
    const retained: { close(): Promise<void> }[] = [];
    const owner: RetainedResourceScope = {
      retain: (resource) => retained.push(resource),
      run: (operation) => operation(),
    };
    const reason = new Error("cancel at the post-open checkpoint");
    const controller = new AbortController();
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      controller.abort(reason);
      return handle;
    });
    const denial = new Error(
      "descriptor close denied after post-open cancellation",
    );
    vi.spyOn(OwnedFileHandle.prototype, "close").mockRejectedValue(denial);
    let cancellation: unknown;
    try {
      cancellation = await readIdaConfiguration(path, {
        resourceScope: owner,
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      expect(controller.signal.aborted).toBe(true);
      expect(cancellation).toMatchObject({
        _tag: "AnalysisCancelledError",
        cleanupIncomplete: true,
      });
      expect((cancellation as Error).cause).toBe(reason);
      expect(retained).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      for (const resource of retained) await resource.close();
    }
    expect(cancellation).toMatchObject({ cleanupIncomplete: false });
  });
  it("retains completed-read facts and cancellation through a denied final close", async () => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    await writeFile(path, ATTACHED_REGISTRATION);
    const retained: { close(): Promise<void> }[] = [];
    const owner: RetainedResourceScope = {
      retain: (resource) => retained.push(resource),
      run: (operation) => operation(),
    };
    const reason = new Error("cancel while closing IDA registration");
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const closeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const denial = new Error("descriptor close denied after cancellation");
    vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(
      async function (this: OwnedFileHandle) {
        entered();
        await closeGate;
        throw denial;
      },
    );
    const pending = readIdaConfiguration(path, {
      resourceScope: owner,
      signal: controller.signal,
    });
    await closeEntered;
    controller.abort(reason);
    release();
    const cancellation = await pending.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(cancellation).toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: reason,
      cleanupIncomplete: true,
    });
    expect(retained).toHaveLength(1);
    vi.restoreAllMocks();
    await retained[0]!.close();
    expect(cancellation).toMatchObject({ cleanupIncomplete: false });
  });
});

it.each(["env", "headers"] as const)(
  "preserves explicit IDA %s keys and rejects invalid values at the same keys",
  async (field) => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    const mapping = JSON.parse(
      '{"__proto__":"operator","constructor":"selected","normal":"value"}',
    );
    const transport =
      field === "env"
        ? { command: "python", protocol: "native" }
        : { url: "http://127.0.0.1:8745/mcp", protocol: "native" };
    await writeFile(path, JSON.stringify({ ...transport, [field]: mapping }));
    const result = await read(path);
    if (!result.ok) throw result.error;
    const parsed =
      field === "env" && "env" in result.value
        ? result.value.env
        : "headers" in result.value
          ? result.value.headers
          : undefined;
    expect(parsed).toEqual(mapping);
    expect(Object.hasOwn(parsed ?? {}, "__proto__")).toBe(true);

    for (const value of [42, null, {}]) {
      await writeFile(
        path,
        JSON.stringify({
          ...transport,
          [field]: Object.fromEntries([["__proto__", value]]),
        }),
      );
      expect((await read(path)).ok, JSON.stringify(value)).toBe(false);
    }
  },
);

describe("IDA registration compatibility profiles", () => {
  it.each([
    { url: "http://127.0.0.1:13337/mcp", mode: "attached", protocol: "legacy" },
    {
      mcpServers: {
        "ida-pro-mcp": { command: "python", protocol: "legacy" },
      },
    },
  ])("refuses the removed legacy protocol in %j", async (input) => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    await writeFile(path, JSON.stringify(input));
    const parsed = await read(path);
    if (parsed.ok) throw new Error("Expected the legacy protocol to fail");
    const constraint = `protocol: ${LEGACY_PROTOCOL_REMOVED}`;
    expect(parsed.error.settings).toEqual([
      { setting: "REA_IDA_MCP_CONFIG", constraint },
    ]);
    expect(parsed.error.message).toContain(constraint);
    expect(constraint).toContain('"protocol": "native"');
  });

  it.each([
    [{ command: "python", args: ["server.py"] }, 'set protocol to "native"'],
    [
      { url: "http://127.0.0.1:13337/mcp", mode: "attached" },
      'set protocol to "native"',
    ],
    [
      { command: "python", mode: "headless", protocol: "native" },
      'a headless registration omits protocol or sets "hexrays"',
    ],
    [
      {
        url: "http://127.0.0.1:13337/mcp",
        mode: "headless",
        protocol: "native",
      },
      'a headless registration omits protocol or sets "hexrays"',
    ],
    [
      { command: "uvx", args: ["ida-mcp", "stdio"], protocol: "hexrays" },
      "requires a headless stdio registration",
    ],
    [
      {
        url: "http://127.0.0.1:8737/mcp",
        mode: "headless",
        protocol: "hexrays",
      },
      "requires a headless stdio registration",
    ],
  ] as const)("rejects incompatible registration %j", async (input, reason) => {
    const root = await createTestTempDirectory("rea-ida-config-");
    const path = join(root, "mcp.json");
    await writeFile(path, JSON.stringify(input));
    const parsed = await read(path);
    if (parsed.ok)
      throw new Error("Expected incompatible registration to fail");
    expect(parsed.error.settings).toEqual([
      {
        setting: "REA_IDA_MCP_CONFIG",
        constraint: expect.stringContaining(reason),
      },
    ]);
  });

  it.each([
    {
      command: "python",
      args: ["server.py"],
      protocol: "modern",
      inputProtocol: {},
    },
    {
      command: "uvx",
      args: ["ida-mcp", "stdio"],
      protocol: "hexrays",
      inputProtocol: { protocol: "hexrays" },
    },
  ])(
    "resolves a headless $protocol registration",
    async ({ command, args, protocol, inputProtocol }) => {
      const root = await createTestTempDirectory("rea-ida-config-");
      const path = join(root, "mcp.json");
      await writeFile(
        path,
        JSON.stringify({ command, args, mode: "headless", ...inputProtocol }),
      );
      expect(await read(path)).toMatchObject({
        ok: true,
        value: { command, args, mode: "headless", protocol },
      });
    },
  );
});
