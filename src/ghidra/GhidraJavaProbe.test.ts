import { describe, expect, it, afterEach, vi } from "vitest";
import { systemProcessOwnershipHost } from "../process/ProcessOwnershipObservation.js";
import { probeGhidraJava, parseGhidraJavaOutput } from "./GhidraJavaProbe.js";
import { createInspectionResources } from "../../tests/fixtures/inspectionResources.js";
let resources = createInspectionResources();
afterEach(async () => {
  await resources.close();
  resources = createInspectionResources();
});
const probe = (values: {
  readonly stdout?: Buffer;
  readonly stderr?: Buffer;
  readonly status?: number | null;
  readonly signal?: NodeJS.Signals | null;
}) => {
  const stdout = values.stdout ?? Buffer.alloc(0),
    stderr = values.stderr ?? Buffer.alloc(0);
  return parseGhidraJavaOutput("/selected/bin/java", {
    stdout: {
      text: stdout.toString("utf8"),
      bytes: stdout.length,
      observedBytes: stdout.length,
    },
    stderr: {
      text: stderr.toString("utf8"),
      bytes: stderr.length,
      observedBytes: stderr.length,
    },
    exitCode: values.status === undefined ? 0 : values.status,
    signal: values.signal ?? null,
  });
};

describe("Ghidra Java prerequisite process facts", () => {
  it.each([
    ["ENOENT", "runtime_missing"],
    ["EACCES", "runtime_unavailable"],
    ["ETIMEDOUT", "runtime_unavailable"],
    ["ENOBUFS", "runtime_unavailable"],
  ])(
    "keeps %s distinct from other runtime failures",
    async (code, expected) => {
      const error = Object.assign(new Error(`controlled ${code}`), { code });
      const result = await probeGhidraJava(
        "/selected/bin/java",
        {},
        {
          resourceOwner: resources.owner,
          launcher: async () => {
            throw error;
          },
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "GhidraJavaProbeFailure",
          code: expected,
          processErrorCode: code,
          detail: expect.stringContaining(code),
        },
      });
      expect(result.ok ? null : result.error).not.toHaveProperty("output");
    },
  );

  it("keeps raw byte counts and both streams on a nonzero exit", () => {
    const result = probe({
      status: 7,
      stdout: Buffer.from([0xff]),
      stderr: Buffer.from("controlled runtime failure\n"),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "runtime_unavailable",
        detail: expect.stringContaining("Java exited 7"),
        output: {
          stdout: "\ufffd",
          stdout_bytes: 1,
          stderr: "controlled runtime failure\n",
          stderr_bytes: 27,
          exit_code: 7,
          signal: null,
          truncated: false,
        },
      },
    });
  });

  it("retains partial parsed properties when a successful probe cannot establish its version", () => {
    expect(
      probe({
        stdout: Buffer.from(
          "java.home = /selected/jdk\nos.arch = aarch64\nsun.arch.data.model = 64\n",
        ),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "version_unresolved",
        properties: {
          home: "/selected/jdk",
          version: null,
          osArch: "aarch64",
          bits: 64,
        },
        output: { exit_code: 0 },
      },
    });
  });

  it("bounds diagnostic text and preserves examined stream sizes", () => {
    expect(probe({ status: 7, stdout: Buffer.alloc(12000, 65) })).toMatchObject(
      {
        ok: false,
        error: {
          output: {
            stdout: "A".repeat(8192),
            stdout_bytes: 12000,
            stderr_bytes: 0,
            truncated: true,
          },
        },
      },
    );
  });
});

it.each([
  "21garbage",
  "garbage",
  "21.foo",
  "9007199254740993",
  "21.9999999999999999",
  "21+9999999999999999",
  "1.21.0",
  "21.0",
  "021",
])("keeps malformed java.version %s unresolved", (version) => {
  expect(
    probe({
      stdout: Buffer.from(
        `java.home = /selected/jdk\njava.version = ${version}\nsun.arch.data.model = 64\n`,
      ),
    }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "version_unresolved",
      properties: { version, home: "/selected/jdk" },
    },
  });
});

it.each([
  ["21-ea", 21],
  ["21.0.11+9-LTS", 21],
  ["27-internal+0-adhoc.user.build", 27],
  ["1.8.0_452-b09", 8],
] as const)("recognizes the Java major in %s", (version, major) => {
  expect(
    probe({
      stdout: Buffer.from(
        `java.home = /selected/jdk\njava.version = ${version}\nsun.arch.data.model = 64\n`,
      ),
    }),
  ).toMatchObject({ ok: true, value: { version, major } });
});

it.skipIf(process.platform !== "darwin")(
  "preserves the caller reason when Java ownership baseline preparation is cancelled",
  async () => {
    const reason = { cancelled: "baseline" };
    const controller = new AbortController();
    const prepare = vi
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockResolvedValue();
    const capture = vi
      .spyOn(systemProcessOwnershipHost, "captureBaseline")
      .mockImplementation(async () => {
        controller.abort(reason);
        throw reason;
      });
    try {
      const result = await probeGhidraJava(
        "/unused/java",
        {},
        { resourceOwner: resources.owner, signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        cause: reason,
      });
    } finally {
      prepare.mockRestore();
      capture.mockRestore();
    }
  },
);
