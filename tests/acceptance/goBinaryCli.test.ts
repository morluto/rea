import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  createGoBinaryByteStringFixture,
  createGoBinaryDiagnosticFixtures,
  createGoBinaryFixture,
  createGoBinaryPathFailureFixture,
  GO_MODULE_TEXT,
} from "../fixtures/go/image.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

for (const expectedErrno of ["ELOOP", "ENAMETOOLONG"] as const) {
  cliTest.skipIf(expectedErrno === "ELOOP" && process.platform === "win32")(
    `reports native ${expectedErrno} path failure as invalid selected-path input through the public Go CLI`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-go-cli-path-failure-");
      const { path, errno } = await createGoBinaryPathFailureFixture(
        root,
        expectedErrno,
      );
      const result = await cli.run({
        arguments: ["inspect-go-binary", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_go_binary",
          issues: [
            {
              path: ["path"],
              reason: "invalid_value",
              message: expect.stringContaining(errno),
            },
          ],
        },
      });
      expect(result.json).toMatchObject({
        details: { issues: [{ message: expect.stringContaining(path) }] },
      });
    },
  );
}

cliTest(
  "preserves invalid embedded Go text bytes through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-go-cli-byte-strings-");
    const path = join(root, "byte-strings.elf");
    const fixture = createGoBinaryByteStringFixture();
    await writeFile(path, fixture.bytes);
    const result = await cli.run({
      arguments: ["inspect-go-binary", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_go_binary").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.build_info).toEqual(
      fixture.expectedBuildInfo,
    );
  },
);

for (const fixture of createGoBinaryDiagnosticFixtures()) {
  cliTest(
    `reports ${fixture.code} for ${fixture.name} through the public Go CLI`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-go-cli-mz-");
      const path = join(root, `${fixture.name}.exe`);
      await writeFile(path, fixture.bytes);
      const result = await cli.run({
        arguments: ["inspect-go-binary", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: fixture.code,
        details: {
          ...fixture.details,
          ...(fixture.code === "unsupported_target" ? { path } : {}),
        },
      });
    },
  );
}

cliTest(
  "reports a readable unsupported carrier through the public Go CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-go-cli-");
    const path = join(root, "text.bin");
    await writeFile(path, "This is not an executable container.");
    const result = await cli.run({
      arguments: ["inspect-go-binary", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: { operation: "inspect_go_binary", path },
    });
  },
);

for (const format of ["elf", "pe", "macho"] as const) {
  for (const encoding of ["inline", "pointer"] as const) {
    cliTest(
      `inspects authored ${format} ${encoding} build metadata through the compiled CLI`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-go-cli-");
        const fixture = createGoBinaryFixture({ format, encoding });
        const path = join(root, "application.bin");
        await writeFile(path, fixture.bytes);
        const result = await cli.run({
          arguments: ["inspect-go-binary", "application.bin", "--json"],
          cwd: root,
        });
        expect(result.exitCode, result.stderr).toBe(0);
        const evidence = toolContract("inspect_go_binary").outputSchema.parse(
          result.json,
        );
        expect(evidence.raw_result).toBeNull();
        expect(evidence.subject?.local_path).toBe(path);
        expect(evidence.subject?.digest.sha256).toBe(
          createHash("sha256").update(fixture.bytes).digest("hex"),
        );
        const report = evidence.normalized_result;
        expect(report).toMatchObject({
          format,
          bits: 64,
          byte_order: "little",
          artifact: { path, bytes: fixture.bytes.length },
        });
        expect(report.build_info).toMatchObject({
          header_offset: fixture.headerOffset,
          encoding,
          go_version: "go1.26.0",
          module_text: GO_MODULE_TEXT,
          module_bytes_base64: fixture.moduleBytes.toString("base64"),
          module: {
            path: "example.com/tool/cmd/tool",
            main: {
              path: "example.com/tool",
              version: "(devel)",
              sum: "",
              replacement: null,
            },
            dependencies: [
              {
                path: "example.com/dependency",
                version: "v1.2.3",
                sum: "h1:sample",
                replacement: { path: "../dependency", version: "", sum: "" },
              },
            ],
            complete: true,
            unparsed_lines: [],
          },
        });
        expect(report.build_info?.module.settings).toContainEqual({
          key: "-ldflags",
          value: "-s -w",
        });
        if (report.build_info === null)
          throw new Error("Fixture build metadata must be present");
        const version = report.build_info.version_location;
        const module = report.build_info.module_location;
        expect(
          fixture.bytes
            .subarray(version.offset, version.offset + version.bytes)
            .toString("utf8"),
        ).toBe(report.build_info.go_version);
        expect(
          fixture.bytes.subarray(module.offset, module.offset + module.bytes),
        ).toEqual(Buffer.from(report.build_info.module_bytes_base64, "base64"));
      },
    );
  }
}

cliTest(
  "reports missing build information as unknown and preserves unsupported carriers distinctly",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-go-cli-");
    const path = join(root, "metadata-free.elf");
    await writeFile(path, createGoBinaryFixture({ omitBuildInfo: true }).bytes);
    const result = await cli.run({
      arguments: ["inspect-go-binary", path, "--json"],
    });
    expect(result.exitCode).toBe(0);
    const report = toolContract("inspect_go_binary").outputSchema.parse(
      result.json,
    ).normalized_result;
    expect(report.build_info).toBeNull();
    expect(report.limitations.join(" ")).toContain(
      "does not establish that the binary is not Go",
    );
  },
);
