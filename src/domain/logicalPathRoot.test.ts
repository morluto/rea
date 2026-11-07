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
