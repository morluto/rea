import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { JADX_BRIDGE_IDENTITY } from "../../../dist/android/JadxRelease.js";

/** Retained Java diagnostics tail; a failing bridge can be arbitrarily noisy. */
const STDERR_TAIL_BYTES = 64 * 1024;

/**
 * Input schemas and property types the bridge advertises for the tools it
 * reimplements. REA owns these, so a caller can page, select over one overload
 * and read manifest facts without depending on whichever schema the pinned
 * engine happens to publish.
 */
const expectedInputs = {
  list_classes: {
    properties: { offset: "integer", limit: "integer", query: "string" },
    required: [],
  },
  get_class_summary: {
    properties: { class_name: "string", dex_static_values: "boolean" },
    required: ["class_name"],
  },
  get_method_body: {
    properties: {
      class_name: "string",
      method_name: "string",
      overload_index: "integer",
    },
    required: ["class_name", "method_name"],
  },
  get_xrefs_to_class: {
    properties: { class_name: "string" },
    required: ["class_name"],
  },
  get_xrefs_to_method: {
    properties: {
      class_name: "string",
      method_name: "string",
      overload_index: "integer",
    },
    required: ["class_name", "method_name"],
  },
  rea_jvm_status: { properties: {}, required: [] },
  rea_native_declarations: {
    properties: { path: "string" },
    required: ["path"],
  },
  get_app_info: { properties: {}, required: [] },
  get_android_manifest: { properties: {}, required: [] },
};

/** Prove the real bridge advertises a serializable, REA-owned tool catalog. */
export const verifyAndroidBridgeCatalog = async ({
  java,
  jar,
  bridge,
  repository,
  jvmArguments = [],
}) => {
  const transport = new StdioClientTransport({
    command: java,
    args: [...jvmArguments, "-classpath", jar, bridge],
    cwd: repository,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-STDERR_TAIL_BYTES);
  });
  const client = new Client({ name: "rea-bridge-catalog", version: "1" });
  try {
    await client.connect(transport);
    assert.deepEqual(
      client.getServerVersion(),
      {
        name: JADX_BRIDGE_IDENTITY.name,
        version: JADX_BRIDGE_IDENTITY.version,
      },
      "The bridge must report the identity REA expects",
    );
    const tools = new Map(
      (await client.listTools()).tools.map((tool) => [tool.name, tool]),
    );
    assert.deepEqual(
      [...tools.keys()].sort(),
      [...Object.keys(expectedInputs), "load_apk"].sort(),
      "The bridge must advertise only the tools REA consumes",
    );
    assert.ok(
      tools.get("load_apk").inputSchema.properties?.path,
      "load_apk must keep advertising the caller's target path",
    );
    for (const [name, expected] of Object.entries(expectedInputs)) {
      const { inputSchema } = tools.get(name);
      const properties = inputSchema.properties ?? {};
      assert.deepEqual(
        Object.keys(properties).sort(),
        Object.keys(expected.properties).sort(),
        `${name} input properties`,
      );
      for (const [field, type] of Object.entries(expected.properties))
        assert.equal(
          properties[field]?.type,
          type,
          `${name}.${field} must stay ${type}`,
        );
      assert.deepEqual(
        [...(inputSchema.required ?? [])].sort(),
        [...expected.required].sort(),
        `${name} required fields`,
      );
    }
    console.log("PASS real bridge tool catalog and input schemas");
  } catch (cause) {
    const tail = diagnostics.trim();
    if (tail === "") throw cause;
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}\n--- bridge stderr (last ${STDERR_TAIL_BYTES} bytes) ---\n${tail}`,
      { cause },
    );
  } finally {
    await client.close();
    await transport.close();
  }
};
