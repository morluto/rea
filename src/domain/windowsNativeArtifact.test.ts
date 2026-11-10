import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { windowsNativeArtifactFixture } from "../../tests/fixtures/windowsNativeArtifact.js";
import {
  WINDOWS_NATIVE_SOURCE_FILES,
  computeWindowsNativeSourceSha256,
  createWindowsNativeManifest,
  parseWindowsNativeManifest,
  validateWindowsNativeArtifact,
} from "./windowsNativeArtifact.js";

it("produces and admits the exact manifest/byte identity", () => {
  const { bytes, manifest } = windowsNativeArtifactFixture();
  const created = createWindowsNativeManifest("1.0.0", bytes);
  expect(created).toEqual({ ok: true, value: manifest });
  const parsed = parseWindowsNativeManifest(manifest, "1.0.0");
  expect(parsed).toEqual(created);
  if (!parsed.ok) throw parsed.error;
  expect(validateWindowsNativeArtifact(parsed.value, bytes)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(parseWindowsNativeManifest(manifest, "2.0.0")).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("another REA version") },
  });
  expect(
    validateWindowsNativeArtifact(parsed.value, Buffer.alloc(128)),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("SHA-256") },
  });
});

it.each([null, [], {}, "manifest"])(
  "rejects malformed manifest %j",
  (value) => {
    expect(parseWindowsNativeManifest(value, "1.0.0")).toMatchObject({
      ok: false,
      error: { _tag: "WindowsNativeArtifactError" },
    });
  },
);

it("rejects missing and unknown manifest fields", () => {
  const { manifest } = windowsNativeArtifactFixture();
  expect(
    parseWindowsNativeManifest({ ...manifest, extra: true }, "1.0.0"),
  ).toMatchObject({ ok: false });
  for (const key of Object.keys(manifest)) {
    const incomplete: Record<string, unknown> = { ...manifest };
    delete incomplete[key];
    expect(parseWindowsNativeManifest(incomplete, "1.0.0")).toMatchObject({
      ok: false,
    });
    expect(
      parseWindowsNativeManifest({ ...manifest, [key]: null }, "1.0.0"),
    ).toMatchObject({ ok: false });
  }
});

it.each([
  "platform",
  "architecture",
  "abiVersion",
  "nodeApiVersion",
  "artifact",
  "artifactSha256",
])("rejects unsupported %s", (key) => {
  const { manifest } = windowsNativeArtifactFixture();
  expect(
    parseWindowsNativeManifest({ ...manifest, [key]: "unsupported" }, "1.0.0"),
  ).toMatchObject({ ok: false });
});

it.each([0, 63, 64, 89, 128])(
  "rejects invalid PE content in %i bytes",
  (length) => {
    expect(
      createWindowsNativeManifest("1.0.0", Buffer.alloc(length)),
    ).toMatchObject({ ok: false });
  },
);

it.each(["offset", "signature", "machine", "optional magic"])(
  "rejects invalid PE %s with a matching digest",
  (field) => {
    const { bytes } = windowsNativeArtifactFixture();
    if (field === "offset") bytes.writeUInt32LE(0xffff_ffff, 0x3c);
    if (field === "signature") bytes.write("BAD!", 64, "ascii");
    if (field === "machine") bytes.writeUInt16LE(0x14c, 68);
    if (field === "optional magic") bytes.writeUInt16LE(0x10b, 88);
    const { manifest } = windowsNativeArtifactFixture();
    manifest.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    const parsed = parseWindowsNativeManifest(manifest, "1.0.0");
    if (!parsed.ok) throw parsed.error;
    expect(validateWindowsNativeArtifact(parsed.value, bytes)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("PE32+") },
    });
  },
);

it.each([0, 1, 65, 0xffff])(
  "rejects an unavailable declared optional header of %i bytes",
  (length) => {
    const { bytes } = windowsNativeArtifactFixture();
    bytes.writeUInt16LE(length, 84);
    expect(createWindowsNativeManifest("1.0.0", bytes)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("PE32+") },
    });
  },
);

it.each([2, 32, 63, 64])(
  "admits PE32+ identity in a present declared header of %i bytes",
  (length) => {
    const { bytes } = windowsNativeArtifactFixture();
    bytes.writeUInt16LE(length, 84);
    expect(createWindowsNativeManifest("1.0.0", bytes)).toMatchObject({
      ok: true,
    });
  },
);

it("supports ARM64 manifests, sourceSha256 binding, and multi-architecture artifacts tables", () => {
  const x64 = windowsNativeArtifactFixture("x64");
  const arm64 = windowsNativeArtifactFixture("arm64");
  const sources = Object.fromEntries(
    WINDOWS_NATIVE_SOURCE_FILES.map((path) => [path, Buffer.from(path)]),
  );
  const sourceDigest = computeWindowsNativeSourceSha256(sources);
  expect(sourceDigest.ok).toBe(true);
  if (!sourceDigest.ok) throw sourceDigest.error;

  const createdX64 = createWindowsNativeManifest("1.0.0", x64.bytes, {
    architecture: "x64",
    sourceSha256: sourceDigest.value,
    includeArtifactsTable: true,
  });
  expect(createdX64.ok).toBe(true);
  if (!createdX64.ok) throw createdX64.error;

  const combined = createWindowsNativeManifest("1.0.0", arm64.bytes, {
    architecture: "arm64",
    sourceSha256: sourceDigest.value,
    preservedArtifacts: createdX64.value.artifacts,
  });
  expect(combined.ok).toBe(true);
  if (!combined.ok) throw combined.error;

  const resolvedX64 = parseWindowsNativeManifest(
    combined.value,
    "1.0.0",
    "x64",
  );
  const resolvedArm64 = parseWindowsNativeManifest(
    combined.value,
    "1.0.0",
    "arm64",
  );
  expect(resolvedX64.ok && resolvedArm64.ok).toBe(true);
  if (!resolvedX64.ok || !resolvedArm64.ok) return;

  expect(validateWindowsNativeArtifact(resolvedX64.value, x64.bytes)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(
    validateWindowsNativeArtifact(resolvedArm64.value, arm64.bytes),
  ).toEqual({
    ok: true,
    value: undefined,
  });
  expect(
    parseWindowsNativeManifest(
      { ...combined.value, sourceSha256: "invalid" },
      "1.0.0",
    ),
  ).toMatchObject({ ok: false });
  expect(
    parseWindowsNativeManifest(
      {
        ...combined.value,
        artifacts: {
          ...combined.value.artifacts,
          arm64: {
            artifact: "rea-windows-arm64.node",
            artifactSha256: "0".repeat(64),
          },
        },
      },
      "1.0.0",
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("artifacts table") },
  });
});
