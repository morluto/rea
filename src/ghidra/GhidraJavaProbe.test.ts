import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ghidraProfileInstallationHost } from "./GhidraInstallation.fixture.js";
import { inspectGhidraInstallation } from "./GhidraInstallation.js";
import { projectGhidraDoctorInspection } from "./GhidraDoctor.js";
import { describe, expect, it, afterEach } from "vitest";
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
  "21 ",
  " 21",
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

// This inert JVM stand-in exercises the real probe process boundary and doctor
// projection. Its scalar format matches OpenJDK LauncherHelper.printPropertyValue.
it.skipIf(process.platform === "win32").each([
  { suffix: "", newline: "\n" },
  { suffix: " ", newline: "\n" },
  { suffix: "\t", newline: "\n" },
  { suffix: " \t", newline: "\n" },
  { suffix: " ", newline: "\r\n" },
])(
  "preserves JDK home and doctor registration with property framing %j",
  async ({ suffix, newline }) => {
    const directory = await createTestTempDirectory("rea-java-home-");
    const home = join(directory, `jdk${suffix}`);
    await mkdir(join(home, "bin"), { recursive: true });
    const command = join(home, "bin", "java");
    const properties = [
      "Property settings:",
      `    java.home = ${home}`,
      "    java.version = 21.0.11",
      "    java.vm.name = OpenJDK 64-Bit Server VM",
      `    os.arch = ${process.arch === "arm64" ? "aarch64" : "amd64"}`,
      `    os.name = ${process.platform === "darwin" ? "Mac OS X" : "Linux"}`,
      "    sun.arch.data.model = 64",
      "",
    ].join(newline);
    await writeFile(
      command,
      `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(properties)});\n`,
      { mode: 0o755 },
    );
    await writeFile(join(home, "bin", "javac"), "", { mode: 0o755 });
    const inspection = await inspectGhidraInstallation(
      {
        resourceOwner: resources.owner,
        environment: process.env,
        installDir: "/selected/ghidra",
        javaHome: home,
        platform: process.platform,
        architecture: process.arch,
      },
      { ...ghidraProfileInstallationHost, probeJava: probeGhidraJava },
    );
    expect(inspection).toMatchObject({ status: "available", javaHome: home });
    expect(projectGhidraDoctorInspection(inspection)).toMatchObject({
      available: true,
      registrationEnvironment: { JAVA_HOME: home },
    });
  },
);

it.each(["java.home=/selected/jdk", "java.home =\t/selected/jdk"])(
  "keeps nonstandard property framing unresolved: %s",
  (line) => {
    expect(
      probe({ stdout: Buffer.from(`${line}\n    java.version = 21\n`) }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "version_unresolved",
        properties: { home: null, version: "21" },
      },
    });
  },
);

it("preserves scalar whitespace for architecture and bitness validation", () => {
  expect(
    probe({
      stdout: Buffer.from(
        [
          "    java.home = /selected/jdk",
          "    java.version = 21",
          "    java.vm.name = OpenJDK 64-Bit Server VM ",
          "    os.arch = amd64 ",
          "    os.name = Linux\t",
          "    sun.arch.data.model = 64 ",
          "",
        ].join("\r\n"),
      ),
    }),
  ).toMatchObject({
    ok: true,
    value: {
      vmName: "OpenJDK 64-Bit Server VM ",
      osArch: "amd64 ",
      osName: "Linux\t",
      bits: null,
      unparsedBits: "64 ",
    },
  });
});
