import { mkdir, open as fsOpen, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DoctorHost } from "../../../src/application/Doctor.js";
import { ConfigurationError } from "../../../src/domain/configurationErrors.js";
import {
  filterClientsNeedingConfigure,
  systemSetupHost,
} from "../../../src/application/SetupHost.js";
import { RegularFileCleanupFailure } from "../../../src/application/RegularFileRead.js";
import { configureDetectedClients } from "../../../src/application/SetupClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const openMock = vi.mocked(fsOpen);
let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  openMock.mockImplementation((...args) => actualFs.open(...args));
});

afterEach(() => openMock.mockReset());

const holdReadHandle = (path: string, reason: string) => {
  const closeAttempts: object[] = [];
  let released = false;
  openMock.mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args);
    if (String(args[0]) !== path) return handle;
    const nativeClose = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closeAttempts.push(handle);
      if (!released) throw new Error(reason);
      await nativeClose();
    });
    return handle;
  });
  return {
    closeAttempts,
    release: () => {
      released = true;
    },
  };
};

/** Linux setup host with its VS Code client configuration directory prepared. */
const preparedVsCodeSetupHost = async (prefix: string) => {
  const home = await createTestTempDirectory(prefix);
  const host = systemSetupHost(
    { platform: "linux", homeDirectory: home } as DoctorHost,
    { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") },
  );
  const client = (await host.supportedClients()).find(
    ({ name }) => name === "vscode",
  );
  if (client === undefined) throw new Error("VS Code setup client missing");
  await mkdir(dirname(client.configPath), { recursive: true });
  return { home, host, client };
};

/** Release the held read handle and show host cleanup reuses it as a third attempt. */
const expectCloseReclaimsHandle = async (
  host: { close?: () => Promise<string | undefined> },
  closeAttempts: readonly object[],
  release: () => void,
) => {
  release();
  expect(await host.close?.()).toBeUndefined();
  expect(closeAttempts).toHaveLength(3);
  expect(closeAttempts[2]).toBe(closeAttempts[0]);
};

/** Give up on the assertion path: release the handle and let cleanup close it. */
const cleanupHeldHandle = async (
  host: { close?: () => Promise<string | undefined> },
  release: () => void,
) => {
  release();
  await host.close?.();
};

it("retains invalid UTF-8 diagnostics and the uninstall read owner when close fails", async () => {
  const home = await createTestTempDirectory("rea-uninstall-utf8-close-");
  const path = join(home, "client.json");
  const original = Buffer.from([0xff]);
  await writeFile(path, original);
  const { closeAttempts, release } = holdReadHandle(
    path,
    "held uninstall handle",
  );
  const host = systemUninstallHost(home, undefined, { HOME: home }, "linux");
  try {
    expect(
      await host.removeClient({
        name: "cursor",
        format: "json",
        configPath: path,
      }),
    ).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("not valid UTF-8"),
    });
    expect(await readFile(path)).toEqual(original);
    expect(closeAttempts).toHaveLength(2);
    await expectCloseReclaimsHandle(host, closeAttempts, release);
  } finally {
    await cleanupHeldHandle(host, release);
  }
});

describe("ZCode fallback cleanup ownership", () => {
  it.each(["preflight", "configure"])(
    "retains a failed ZCode fallback close during %s until host cleanup",
    async (operation) => {
      const home = await createTestTempDirectory("rea-zcode-fallback-close-");
      const host = systemSetupHost(
        { platform: "linux", homeDirectory: home } as DoctorHost,
        { HOME: home },
      );
      const client = (await host.supportedClients()).find(
        ({ name }) => name === "zcode",
      );
      if (client?.zcodeFallbackPath === undefined)
        throw new Error("ZCode fallback path missing");
      const fallback = client.zcodeFallbackPath;
      await mkdir(dirname(fallback), { recursive: true });
      const original = '{"mcpServers":{"other":{"command":"other"}}}\n';
      await writeFile(fallback, original);
      const { closeAttempts, release } = holdReadHandle(
        fallback,
        "held fallback handle",
      );
      try {
        const action =
          operation === "preflight"
            ? host.inspectClientConfiguration?.(client, {}, ["rea", "mcp"])
            : host.configureClient(client, {}, ["rea", "mcp"]);
        if (action === undefined) throw new Error("setup preflight missing");
        await expect(action).rejects.toMatchObject({
          _tag: "ConfigurationError",
          cause: expect.any(RegularFileCleanupFailure),
          cleanup: { resources: [fallback] },
        });
        expect(closeAttempts).toHaveLength(2);
        expect(closeAttempts[0]).toBe(closeAttempts[1]);
        expect(await readFile(fallback, "utf8")).toBe(original);
        await expect(readFile(client.configPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expectCloseReclaimsHandle(host, closeAttempts, release);
      } finally {
        await cleanupHeldHandle(host, release);
      }
    },
  );
});

describe("setup client configuration cleanup ownership", () => {
  it.each([
    ["valid UTF-8", Buffer.from('{"servers": {"other": {}}}\n')],
    ["malformed UTF-8", Buffer.from([0xff])],
  ] as const)(
    "stops configuration and retains the %s read owner until host close",
    async (encoding, original) => {
      const { host, client } = await preparedVsCodeSetupHost(
        "rea-setup-config-close-",
      );
      await writeFile(client.configPath, original);

      const { closeAttempts, release } = holdReadHandle(
        client.configPath,
        "test holds the config handle open",
      );
      const configure = vi.spyOn(host, "configureClient");

      try {
        const failure = await filterClientsNeedingConfigure(
          host,
          [client],
          {},
          ["rea", "mcp"],
        )
          .then((detectedClients) =>
            configureDetectedClients({
              host,
              detectedClients,
              providerEnvironment: {},
              command: ["rea", "mcp"],
              clients: {},
              appliedActions: [],
            }),
          )
          .then(
            () => undefined,
            (cause: unknown) => cause,
          );
        expect(failure).toBeInstanceOf(ConfigurationError);
        if (encoding === "malformed UTF-8")
          expect(failure).toMatchObject({
            cause: {
              outcome: { kind: "failed", cause: expect.any(TypeError) },
            },
          });
        expect(failure).toMatchObject({
          _tag: "ConfigurationError",
          cause: expect.any(RegularFileCleanupFailure),
          cleanup: {
            resources: [client.configPath],
            reason: expect.stringContaining(
              "test holds the config handle open",
            ),
          },
        });
        expect(configure).not.toHaveBeenCalled();
        expect(closeAttempts).toHaveLength(2);
        expect(closeAttempts[0]).toBe(closeAttempts[1]);
        expect(await readFile(client.configPath)).toEqual(original);

        await expectCloseReclaimsHandle(host, closeAttempts, release);
      } finally {
        await cleanupHeldHandle(host, release);
      }
    },
  );

  it("waits for an admitted configuration read and rejects later admissions", async () => {
    const { host, client } = await preparedVsCodeSetupHost(
      "rea-setup-config-inflight-",
    );
    await writeFile(client.configPath, '{"servers": {}}\n');

    let beginRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      beginRead = resolve;
    });
    let unblockRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      unblockRead = resolve;
    });
    let heldRead = false;
    openMock.mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (String(args[0]) !== client.configPath || heldRead) return handle;
      heldRead = true;
      const nativeRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        beginRead();
        await readGate;
        return nativeRead(...readArgs);
      });
      return handle;
    });

    let hostCloseFinished = false;
    let alignment: Promise<boolean> | undefined;
    try {
      alignment = host.clientNeedsConfigure(client, {}, ["rea", "mcp"]);
      await readStarted;

      const close = host.close;
      if (close === undefined) throw new Error("Setup host close is missing");
      const closeResult = close().then((result) => {
        hostCloseFinished = true;
        return result;
      });

      const lateAdmission = await host
        .clientNeedsConfigure(client, {}, ["rea", "mcp"])
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      expect(lateAdmission).toBeInstanceOf(ConfigurationError);
      expect(lateAdmission).toMatchObject({
        message: expect.stringContaining("Artifact resource scope is closed"),
      });
      expect(hostCloseFinished).toBe(false);

      unblockRead();
      await expect(alignment).resolves.toBe(true);
      expect(await closeResult).toBeUndefined();
      expect(hostCloseFinished).toBe(true);
    } finally {
      unblockRead();
      await alignment?.catch(() => undefined);
      await host.close?.();
    }
  });
});
