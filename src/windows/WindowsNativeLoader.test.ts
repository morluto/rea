import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  loadWindowsNativeAuthority,
  type WindowsNativeLoadHost,
} from "./WindowsNativeLoader.js";

const fixture = () => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88);
  const manifest = {
    packageVersion: "1.0.0",
    platform: "win32",
    architecture: "x64",
    abiVersion: 1,
    nodeApiVersion: 8,
    artifact: "rea-windows-x64.node",
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const identity = {
    requestedPath: "D:\\fixture\\runtime",
    finalPath: "\\\\?\\D:\\fixture\\runtime",
    filesystem: "NTFS",
    volumeSerial: "0123456789abcdef",
    fileId: "0123456789abcdef0123456789abcdef",
    size: 0,
    directory: true,
  };
  let loads = 0;
  const host: WindowsNativeLoadHost = {
    platform: "win32",
    architecture: "x64",
    nodeApiVersion: "8",
    packageVersion: "1.0.0",
    readManifest: () => manifest,
    readArtifact: () => bytes,
    loadArtifact: () => {
      loads++;
      return {
        call: () => ({
          abiVersion: 1,
          nodeApiVersion: 8,
          architecture: "x64",
          filesystem: identity,
          privateDacl: true,
          atomicJobAssignment: true,
          killOnOwnerClose: true,
        }),
      };
    },
  };
  return { host, manifest, bytes, loads: () => loads };
};

describe("packaged Windows native admission", () => {
  it("loads only after compatibility and digest checks, preserving producer identity", () => {
    const value = fixture();
    expect(loadWindowsNativeAuthority(value.host)).toMatchObject({
      available: true,
      authority: {
        inspection: { filesystem: { requestedPath: "D:\\fixture\\runtime" } },
      },
    });
    expect(value.loads()).toBe(1);
  });

  it.each([
    { platform: "linux" as const },
    { architecture: "arm64" },
    { nodeApiVersion: "7" },
    { nodeApiVersion: undefined },
    { packageVersion: "2.0.0" },
  ])("rejects incompatible host metadata before loading: %j", (override) => {
    const value = fixture();
    expect(
      loadWindowsNativeAuthority({ ...value.host, ...override }).available,
    ).toBe(false);
    expect(value.loads()).toBe(0);
  });

  it("rejects tampering even when the original file was a valid PE image", () => {
    const value = fixture();
    value.bytes[127] = 1;
    expect(loadWindowsNativeAuthority(value.host)).toMatchObject({
      available: false,
      reason: expect.stringContaining("SHA-256"),
    });
    expect(value.loads()).toBe(0);
  });

  it.each(["abiVersion", "nodeApiVersion", "architecture", "artifact"])(
    "rejects invalid manifest %s",
    (key) => {
      const value = fixture();
      expect(
        loadWindowsNativeAuthority({
          ...value.host,
          readManifest: () => ({ ...value.manifest, [key]: "invalid" }),
        }).available,
      ).toBe(false);
      expect(value.loads()).toBe(0);
    },
  );

  it("rejects a digest-valid artifact for another machine", () => {
    const value = fixture();
    value.bytes.writeUInt16LE(0xaa64, 68);
    value.manifest.artifactSha256 = createHash("sha256")
      .update(value.bytes)
      .digest("hex");
    expect(loadWindowsNativeAuthority(value.host)).toMatchObject({
      available: false,
      reason: expect.stringContaining("PE32+"),
    });
    expect(value.loads()).toBe(0);
  });

  it("preserves host permission failure rather than promoting a partial probe", () => {
    const value = fixture();
    expect(
      loadWindowsNativeAuthority({
        ...value.host,
        loadArtifact: () => ({
          call: () => {
            throw new Error("private DACL: access denied");
          },
        }),
      }),
    ).toMatchObject({
      available: false,
      reason: expect.stringContaining("private DACL: access denied"),
    });
  });

  it("requires every inspected native fact", () => {
    const value = fixture();
    expect(
      loadWindowsNativeAuthority({
        ...value.host,
        loadArtifact: () => ({ call: () => ({ privateDacl: true }) }),
      }).available,
    ).toBe(false);
  });
});
