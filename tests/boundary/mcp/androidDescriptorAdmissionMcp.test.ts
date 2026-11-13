import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, vi } from "vitest";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it.each(["compact", "full"])(
  "enforces DEX dimensions with %s input-schema delivery",
  async (profile) => {
    const execute = vi.fn(() => {
      throw new Error("Invalid descriptors must not reach the provider");
    });
    const { client } = await createApplicationMcpHarness({
      serverOptions: {
        androidAnalysis: {
          execute,
          close: async () => {},
          inspectAvailability: vi.fn(),
        },
        environment: {
          REA_MCP_TOOL_FAMILIES: "android,application,session",
          REA_MCP_INPUT_SCHEMA_PROFILE: profile,
        },
      },
    });
    const definition = (await client.listTools()).tools.find(
      ({ name }) => name === "inspect_android_jni_bindings",
    );
    if (definition === undefined) throw new Error("JNI tool is missing");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(definition.inputSchema)).toBe(true);
    const validate = ajv.compile(definition.inputSchema);
    for (const dimensions of [255, 256]) {
      const type = "[".repeat(dimensions) + "I";
      const request = {
        path: "/nonexistent/selected.apk",
        descriptors: [`(${type})${type}`],
      };
      expect(validate(request), JSON.stringify(validate.errors)).toBe(
        // Compact delivery intentionally omits scalar pattern constraints.
        profile === "compact" || dimensions === 255,
      );
      if (dimensions === 256) {
        const result = await client.callTool({
          name: "inspect_android_jni_bindings",
          arguments: request,
        });
        expect(parseMcpToolError(result).error).toMatchObject({
          code: "invalid_request",
        });
      }
    }
    expect(execute).not.toHaveBeenCalled();
  },
);
