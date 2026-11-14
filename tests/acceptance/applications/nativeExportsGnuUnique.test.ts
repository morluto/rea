import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nativeExportsSchema } from "../../../src/domain/native/nativeExports.js";
import { elfExportImage } from "../../fixtures/binaryDiagnostics/nativeExports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const oracle = z
  .object({
    variants: z.array(
      z.object({
        name: z.string(),
        os_abi: z.int().min(0).max(255),
        symbols: z.array(
          z.object({
            name: z.string(),
            value: z.string(),
            size: z.string(),
            type_code: z.int(),
            type: z.enum(["object", "tls"]),
            binding_code: z.int(),
            binding: z.enum(["weak", "unique"]),
            visibility: z.literal("default"),
          }),
        ),
      }),
    ),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL("../../fixtures/elf-gnu-unique/oracle.json", import.meta.url),
        "utf8",
      ),
    ),
  );

for (const variant of oracle.variants) {
  cliTest(
    `preserves GCC ${variant.name} object and TLS bindings through native export Evidence`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-elf-inline-bindings-");
      const path = join(root, `${variant.name}.so`);
      // Reframe independently observed symbol facts in a portable carrier. This
      // does not claim to exercise the compiler's complete ELF layout in CI.
      const bytes = elfExportImage({
        symbols: variant.symbols.map((symbol) => ({
          name: symbol.name,
          type: symbol.type_code,
          binding: symbol.binding_code,
          value: BigInt(symbol.value),
          size: BigInt(symbol.size),
        })),
      });
      bytes[7] = variant.os_abi;
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-native-exports", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = toolContract(
        "inspect_native_exports",
      ).outputSchema.parse(result.json);
      const report = nativeExportsSchema.parse(evidence.normalized_result);
      if (report.format !== "elf")
        throw new Error("Expected ELF export Evidence");
      expect(report).toMatchObject({
        format: "elf",
        artifact: {
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        coverage: { status: "complete", exports: variant.symbols.length },
        issues: [],
      });
      expect(
        report.exports.map(
          ({ name, value, size, type, binding, visibility }) => ({
            name,
            value,
            size,
            type,
            binding,
            visibility,
          }),
        ),
      ).toEqual(
        variant.symbols.map(
          ({ name, value, size, type, binding, visibility }) => ({
            name,
            value,
            size,
            type,
            binding,
            visibility,
          }),
        ),
      );
    },
  );
}
