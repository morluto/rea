import { describe, expect, it } from "vitest";
import {
  normalizeLogicalPath,
  redactEvidenceObservationPaths,
} from "./logicalPathRoot.js";

describe("normalizeLogicalPath", () => {
  it("normalizes a path within the root to the default workspace:// prefix", () => {
    const res = normalizeLogicalPath("/home/alice/project/src/main.ts", {
      root: "/home/alice/project",
    });
    expect(res).toEqual({
      kind: "mapped",
      path: "workspace://src/main.ts",
    });
  });

  it("respects a custom logicalPrefix", () => {
    const res = normalizeLogicalPath("/home/alice/project/src/main.ts", {
      root: "/home/alice/project",
      logicalPrefix: "logical://app/",
    });
    expect(res).toEqual({
      kind: "mapped",
      path: "logical://app/src/main.ts",
    });
  });

  it("handles the exact root directory", () => {
    const res = normalizeLogicalPath("/home/alice/project", {
      root: "/home/alice/project",
      logicalPrefix: "workspace://",
    });
    expect(res).toEqual({
      kind: "mapped",
      path: "workspace://",
    });
  });

  it("preserves a drive-root logical prefix for the mapped root", () => {
    expect(
      normalizeLogicalPath("/home/alice/project", {
        root: "/home/alice/project",
        logicalPrefix: "C:/",
      }),
    ).toEqual({ kind: "mapped", path: "C:/" });
  });

  it("fails closed when path is outside the root and allowOutsideRoot is not set", () => {
    const res = normalizeLogicalPath("/etc/passwd", {
      root: "/home/alice/project",
    });
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      expect(res.reason).toContain("outside the configured logical root");
    }
  });

  it("retains the original path when path is outside the root and allowOutsideRoot is true", () => {
    const res = normalizeLogicalPath("/etc/passwd", {
      root: "/home/alice/project",
      allowOutsideRoot: true,
    });
    expect(res).toEqual({
      kind: "outside-root",
      path: "/etc/passwd",
    });
  });

  it("supports the retainUnmappedPaths alias for allowOutsideRoot", () => {
    const res = normalizeLogicalPath("/etc/passwd", {
      root: "/home/alice/project",
      retainUnmappedPaths: true,
    });
    expect(res).toEqual({
      kind: "outside-root",
      path: "/etc/passwd",
    });
  });

  it("rejects paths with NUL bytes", () => {
    const res = normalizeLogicalPath("/home/alice/project/file\0name", {
      root: "/home/alice/project",
    });
    expect(res).toEqual({
      kind: "invalid",
      reason: "Local filesystem paths cannot contain NUL",
    });
  });

  it("leaves relative paths, URLs, and non-path content unchanged", () => {
    const outcome = redactEvidenceObservationPaths(
      {
        operation: "inspect",
        logicalPathFields: {
          parameters: [["path"]],
          result: [["target_location"]],
        },
        parameters: {
          path: "/home/alice/project/file.bin",
          url: "https://example.com/api",
          digest: "a".repeat(64),
          custom_note: "not a path: /home/alice/project/ignored",
        },
        result: {
          target_location: "/home/alice/project/build/app.bin",
          status: "ok",
          other_url: "file:///some/url",
        },
        locations: [
          { kind: "artifact-path", path: "/home/alice/project/file.bin" },
          { kind: "address", address: "0x1000" },
        ],
      },
      { root: "/home/alice/project" },
    );

    // Mapped fields
    expect(outcome.observation.parameters).toMatchObject({
      path: "workspace://file.bin",
      url: "https://example.com/api",
      digest: "a".repeat(64),
      custom_note: "not a path: /home/alice/project/ignored",
    });
    expect(outcome.observation.result).toMatchObject({
      target_location: "workspace://build/app.bin",
      status: "ok",
      other_url: "file:///some/url",
    });
    expect(outcome.observation.locations).toEqual([
      { kind: "artifact-path", path: "workspace://file.bin" },
      { kind: "address", address: "0x1000" },
    ]);
    expect(outcome.mappedCount).toBe(3);
  });
});

it.skipIf(process.platform === "win32")(
  "treats a double-slash path in a filesystem field as a local path",
  () => {
    expect(
      normalizeLogicalPath("//home/alice/project/app.bin", {
        root: "/home/alice/project",
      }),
    ).toEqual({ kind: "mapped", path: "workspace://app.bin" });
    expect(
      normalizeLogicalPath("//home/other/app.bin", {
        root: "/home/alice/project",
      }).kind,
    ).toBe("invalid");
  },
);

it("retains own __proto__ JSON members when mapping a sibling path", () => {
  const parameters = JSON.parse(
    '{"__proto__":{"keep":true},"path":"/home/alice/project/app.bin"}',
  );
  const result = JSON.parse(
    '{"__proto__":false,"target_location":"/home/alice/project/app.bin"}',
  );
  const mapped = redactEvidenceObservationPaths(
    {
      operation: "inspect",
      parameters,
      result,
      logicalPathFields: {
        parameters: [["path"]],
        result: [["target_location"]],
      },
    },
    { root: "/home/alice/project" },
  );
  expect(mapped.observation.parameters).toEqual(
    JSON.parse('{"__proto__":{"keep":true},"path":"workspace://app.bin"}'),
  );
  expect(mapped.observation.result).toEqual(
    JSON.parse('{"__proto__":false,"target_location":"workspace://app.bin"}'),
  );
  expect(
    Object.hasOwn(mapped.observation.parameters as object, "__proto__"),
  ).toBe(true);
  expect(Object.hasOwn(mapped.observation.result as object, "__proto__")).toBe(
    true,
  );
});

it.skipIf(process.platform !== "win32")(
  "recognizes drive-qualified filesystem paths before URI schemes",
  () => {
    expect(
      normalizeLogicalPath("C:\\repo\\app.bin", { root: "C:\\repo" }),
    ).toEqual({ kind: "mapped", path: "workspace://app.bin" });
    expect(
      normalizeLogicalPath("https://example.com/file", { root: "C:\\repo" }),
    ).toEqual({ kind: "unmodified", path: "https://example.com/file" });
  },
);

it("maps web export and network fields at their producer-owned locations", async () => {
  const { WEB_SCRIPT_EXPORT_LOGICAL_PATH_FIELDS } =
    await import("./webScriptExport.js");
  const { WEB_NETWORK_CAPTURE_LOGICAL_PATH_FIELDS } =
    await import("./webNetworkCapture.js");
  const root = { root: "/tmp/work" };
  const exported = redactEvidenceObservationPaths(
    {
      operation: "export_web_scripts",
      logicalPathFields: WEB_SCRIPT_EXPORT_LOGICAL_PATH_FIELDS,
      parameters: {
        capture_path: "/tmp/work/capture",
        output_directory: "/tmp/work/out",
      },
      result: {
        capture_path: "/tmp/work/capture",
        output_directory: "/tmp/work/out",
        analysis_input: { input_path: "/tmp/work/out" },
        manifest: { path: "/tmp/work/out/manifest.json" },
        scripts: [{ source_path: "/outside/recorded" }],
      },
    },
    root,
  );
  expect(exported.observation.result).toEqual({
    capture_path: "workspace://capture",
    output_directory: "workspace://out",
    analysis_input: { input_path: "workspace://out" },
    manifest: { path: "workspace://out/manifest.json" },
    scripts: [{ source_path: "/outside/recorded" }],
  });
  const captured = redactEvidenceObservationPaths(
    {
      operation: "inspect_web_network_capture",
      logicalPathFields: WEB_NETWORK_CAPTURE_LOGICAL_PATH_FIELDS,
      parameters: {
        capture_path: "/tmp/work/capture",
        protobuf: { schema: { descriptor_set_path: "/tmp/work/schema.pb" } },
      },
      result: {
        artifact: { path: "/tmp/work/capture" },
        records: [{ source_path: "/outside/recorded" }],
      },
    },
    root,
  );
  expect(captured.observation.parameters).toEqual({
    capture_path: "workspace://capture",
    protobuf: { schema: { descriptor_set_path: "workspace://schema.pb" } },
  });
  expect(captured.observation.result).toEqual({
    artifact: { path: "workspace://capture" },
    records: [{ source_path: "/outside/recorded" }],
  });
});

it("supports explicitly declared scalar raw-result paths", () => {
  const mapped = redactEvidenceObservationPaths(
    {
      operation: "inspect_fixture",
      parameters: {},
      result: {},
      rawResult: "/tmp/work/raw.bin",
      logicalPathFields: { rawResult: [[]] },
    },
    { root: "/tmp/work" },
  );
  expect(mapped.observation.rawResult).toBe("workspace://raw.bin");
});
