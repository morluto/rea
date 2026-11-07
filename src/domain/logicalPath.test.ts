import { describe, expect, it } from "vitest";
import {
  logicalPathRedactionLimitation,
  redactEvidenceLocations,
  redactJsonValue,
  redactLogicalPath,
  resolveLogicalPathConfig,
} from "./logicalPath.js";

describe("logical path resolution", () => {
  it("resolves string root with default prefix", () => {
    const config = resolveLogicalPathConfig("/home/user/workspace");
    expect(config).toBeDefined();
    expect(config?.prefix).toBe("$WORKSPACE");
  });

  it("resolves object root with custom prefix", () => {
    const config = resolveLogicalPathConfig({
      logicalRoot: "/work/repo",
      logicalPrefix: "<workspace>",
    });
    expect(config).toBeDefined();
    expect(config?.prefix).toBe("<workspace>");
  });

  it("returns undefined for empty input", () => {
    expect(resolveLogicalPathConfig(undefined)).toBeUndefined();
    expect(resolveLogicalPathConfig("")).toBeUndefined();
    expect(resolveLogicalPathConfig({ logicalRoot: "" })).toBeUndefined();
  });
});

describe("logical path redaction", () => {
  const config = {
    root: "/tmp/run-alpha",
    prefix: "$WORKSPACE",
  };

  it("redacts exact root match", () => {
    expect(redactLogicalPath("/tmp/run-alpha", config)).toBe("$WORKSPACE");
  });

  it("redacts child paths under root", () => {
    expect(redactLogicalPath("/tmp/run-alpha/app/main.rs", config)).toBe(
      "$WORKSPACE/app/main.rs",
    );
    expect(redactLogicalPath("/tmp/run-alpha/a/b/c.txt", config)).toBe(
      "$WORKSPACE/a/b/c.txt",
    );
  });

  it("preserves paths outside the logical root", () => {
    expect(redactLogicalPath("/other/path/main.rs", config)).toBe(
      "/other/path/main.rs",
    );
  });

  it("supports empty prefix", () => {
    const noPrefixConfig = { root: "/tmp/run-alpha", prefix: "" };
    expect(
      redactLogicalPath("/tmp/run-alpha/app/main.rs", noPrefixConfig),
    ).toBe("app/main.rs");
    expect(redactLogicalPath("/tmp/run-alpha", noPrefixConfig)).toBe("");
  });

  it("normalizes Windows backslashes", () => {
    const winConfig = {
      root: "C:/work/run-alpha",
      prefix: "$WORKSPACE",
    };
    expect(
      redactLogicalPath("C:\\work\\run-alpha\\app\\test.bin", winConfig),
    ).toBe("$WORKSPACE/app/test.bin");
  });

  it("redacts embedded occurrences within a string", () => {
    const text = "Error opening /tmp/run-alpha/app/target.bin: not found";
    expect(redactLogicalPath(text, config)).toBe(
      "Error opening $WORKSPACE/app/target.bin: not found",
    );
  });
});

describe("logical path redaction on JSON values and locations", () => {
  const config = {
    root: "/tmp/run-alpha",
    prefix: "$WORKSPACE",
  };

  it("redacts nested JSON structures", () => {
    const input = {
      path: "/tmp/run-alpha/app/target",
      numbers: [1, 2, 3],
      nested: {
        file: "/tmp/run-alpha/app/src/lib.rs",
        count: 10,
        unrelated: "hello",
      },
      list: ["/tmp/run-alpha/app/Cargo.toml", "literal"],
    };
    const expected = {
      path: "$WORKSPACE/app/target",
      numbers: [1, 2, 3],
      nested: {
        file: "$WORKSPACE/app/src/lib.rs",
        count: 10,
        unrelated: "hello",
      },
      list: ["$WORKSPACE/app/Cargo.toml", "literal"],
    };
    expect(redactJsonValue(input, config)).toEqual(expected);
  });

  it("redacts artifact-path locations and leaves address locations untouched", () => {
    const locations = [
      { kind: "artifact-path" as const, path: "/tmp/run-alpha/app/bin" },
      { kind: "address" as const, address: "0x401000" },
    ];
    const redacted = redactEvidenceLocations(locations, config);
    expect(redacted).toEqual([
      { kind: "artifact-path", path: "$WORKSPACE/app/bin" },
      { kind: "address", address: "0x401000" },
    ]);
  });

  it("formats limitation without leaking local root directory", () => {
    const limitation = logicalPathRedactionLimitation(config);
    expect(limitation).toBe(
      "Local filesystem paths were normalized relative to logical root: $WORKSPACE",
    );
    expect(limitation).not.toContain("run-alpha");
  });
});

it("maps Windows roots using the recorded path format on any host", () => {
  const config = resolveLogicalPathConfig("C:\\work\\run-alpha")!;
  expect(redactLogicalPath("c:\\WORK\\run-alpha\\app\\test.bin", config)).toBe(
    "$WORKSPACE/app/test.bin",
  );
  expect(
    redactLogicalPath("C:\\work\\run-alpha\\..\\elsewhere\\test.bin", config),
  ).toBe("C:\\work\\run-alpha\\..\\elsewhere\\test.bin");
  const unc = resolveLogicalPathConfig("\\\\server\\share\\run-alpha")!;
  expect(
    redactLogicalPath("\\\\server\\share\\run-alpha\\app\\test.bin", unc),
  ).toBe("$WORKSPACE/app/test.bin");
});

it("checks normalized POSIX containment and preserves sibling paths", () => {
  const config = resolveLogicalPathConfig("/tmp/run-alpha")!;
  expect(redactLogicalPath("/tmp/run-alpha/../run-beta/file", config)).toBe(
    "/tmp/run-alpha/../run-beta/file",
  );
  expect(redactLogicalPath("/tmp/run-alphabet/file", config)).toBe(
    "/tmp/run-alphabet/file",
  );
  expect(redactLogicalPath("/tmp/run-alpha/app/../file", config)).toBe(
    "$WORKSPACE/file",
  );
});

it("maps repeated separators in embedded diagnostics without changing sibling paths", () => {
  const config = resolveLogicalPathConfig("/home/alice/project")!;
  expect(
    redactLogicalPath(
      "Error opening /home/alice//project/target.bin: not found",
      config,
    ),
  ).toBe("Error opening $WORKSPACE/target.bin: not found");
  expect(
    redactLogicalPath("Unrelated /home/alice/project-other/target.bin", config),
  ).toBe("Unrelated /home/alice/project-other/target.bin");
  expect(
    redactLogicalPath("Token prefix/home/alice/project/target", config),
  ).toBe("Token prefix/home/alice/project/target");
});

it("maps recorded Windows diagnostic roots without treating a sibling as inside", () => {
  const config = resolveLogicalPathConfig("C:\\work\\run-alpha")!;
  expect(
    redactLogicalPath("Failed: c:\\WORK\\\\run-alpha\\target.bin", config),
  ).toBe("Failed: $WORKSPACE\\target.bin");
  expect(
    redactLogicalPath("Failed: C:\\work\\run-alpha2\\target.bin", config),
  ).toBe("Failed: C:\\work\\run-alpha2\\target.bin");
});
