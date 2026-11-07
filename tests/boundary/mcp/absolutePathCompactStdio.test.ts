import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("advertises usable absolute-path contracts and retains other input bounds on default stdio MCP", async () => {
  const root = await createTestTempDirectory("rea-absolute-path-stdio-");
  const path = join(root, "sample.bin");
  await writeFile(path, Buffer.alloc(512));
  const { client } = await connectLocalToolsMcp();
  const tools = (await client.listTools()).tools;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const name of [
    "inspect_byte_entropy",
    "inspect_devicetree",
    "inspect_elf_notes",
    "inspect_apple_ips",
    "inspect_kernel_module",
  ]) {
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) throw new Error(`Missing tool ${name}`);
    const validate = ajv.compile(tool.inputSchema);
    for (const invalid of ["relative.bin", "", `${path}\0`, `${path}\n\0`])
      expect(
        validate({ path: invalid }),
        `${name}: ${JSON.stringify(invalid)}`,
      ).toBe(false);
    expect(validate({ path }), name).toBe(true);
  }
  const entropy = tools.find((entry) => entry.name === "inspect_byte_entropy");
  if (entropy === undefined) throw new Error("Missing entropy tool");
  const validateEntropy = ajv.compile(entropy.inputSchema);
  for (const invalid of [
    { path, block_size: 0 },
    { path, offset: -1 },
    { path, detail: "bogus" },
  ])
    expect(validateEntropy(invalid), JSON.stringify(invalid)).toBe(false);

  for (const [name, valid, invalid] of [
    [
      "export_web_scripts",
      { capture_path: path, output_directory: path },
      { capture_path: "relative.json", output_directory: path },
    ],
    [
      "export_web_scripts",
      { capture_path: path, output_directory: path },
      { capture_path: path, output_directory: "relative-output" },
    ],
    [
      "recover_javascript_sources",
      { path, output_directory: path, additional_paths: [path] },
      { path, output_directory: path, additional_paths: ["relative.js"] },
    ],
    [
      "recover_javascript_sources",
      { path, output_directory: path },
      { path: "relative.js", output_directory: path },
    ],
    [
      "recover_javascript_sources",
      { path, output_directory: path },
      { path, output_directory: "relative-output" },
    ],
  ] as const) {
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) throw new Error(`Missing tool ${name}`);
    const validate = ajv.compile(tool.inputSchema);
    expect(validate(valid), `${name}: ${JSON.stringify(validate.errors)}`).toBe(
      true,
    );
    expect(validate(invalid), `${name}: ${JSON.stringify(invalid)}`).toBe(
      false,
    );
  }

  const rejected = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { path: "relative.bin" },
  });
  expect(parseMcpToolError(rejected).error.code).toBe("invalid_request");
  const rejectedNul = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { path: `${path}\0` },
  });
  expect(parseMcpToolError(rejectedNul).error).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["path"],
          reason: "invalid_format",
          message: "Local filesystem paths cannot contain NUL",
        },
      ],
    },
  });
  const result = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { path },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    operation: "inspect_byte_entropy",
    normalized_result: { artifact: { path, bytes: 512 } },
  });
});
