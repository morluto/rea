import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";

import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { sessionOutputSchemas } from "../../../src/contracts/toolOutputSchemaGroups.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

/** Each tool with the host its execution check admits. */
const HOST_RESTRICTED_TOOLS = [
  ["inspect_packet_capture", "linux"],
  ["inspect_packet_fields", "linux"],
  ["decode_signal_recording", "linux"],
  ["inspect_signal_decoders", "linux"],
  ["inspect_firmware_regions", "linux"],
  ["extract_firmware", "linux"],
  ["inspect_binary_layout", "linux-x64"],
  ["inspect_recorded_crash", "linux-x64"],
  ["recover_javascript_sources", "linux-x64"],
  ["inspect_evm_interface", "linux-x64"],
] as const;

const connect = async (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  options: Parameters<typeof createServer>[1] = {},
): Promise<{
  readonly path: (name: string) => string;
  readonly availability: () => Promise<
    ReturnType<typeof expandToolAvailability>
  >;
  readonly call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly close: () => Promise<void>;
}> => {
  const directory = await createTestTempDirectory("rea-host-restricted-mcp-");
  const path = (name: string) => join(directory, name);
  const session = createTestBinarySession(() => {
    throw new Error("binary analysis must not start during status discovery");
  });
  // Absolute paths configure every integration; discovery does not run them.
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        REA_TSHARK_COMMAND: path("tshark"),
        REA_SIGROK_COMMAND: path("sigrok-cli"),
        REA_BINWALK_COMMAND: path("binwalk"),
        REA_UNBLOB_COMMAND: path("unblob"),
        REA_PWNTOOLS_PYTHON: path("python3"),
        REA_WAKARU_COMMAND: path("wakaru"),
        REA_EVM_PRLIMIT_COMMAND: path("missing-prlimit"),
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      },
      // Discovery and execution checks both read the server's selected host.
      host: { platform, architecture },
      ...options,
    },
  );
  const client = new Client(
    {
      name: "host-restricted-availability",
      version: "1",
    },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    const text = z
      .array(z.object({ type: z.string(), text: z.string().optional() }))
      .parse(response.content)
      .find((item) => item.type === "text")?.text;
    return z
      .record(z.string(), z.unknown())
      .parse(response.structuredContent ?? JSON.parse(text ?? "null"));
  };
  return {
    path,
    availability: async () =>
      expandToolAvailability(
        sessionOutputSchemas.binary_session.parse(
          await call("binary_session", {}),
        ).result.tool_availability,
      ),
    call,
    close: async () => {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    },
  };
};

it.each([
  ["darwin", "arm64"],
  ["linux", "arm64"],
  ["linux", "x64"],
] as const)(
  "reports host-restricted integrations on %s %s by host before configuration",
  async (platform, arch) => {
    const harness = await connect(platform, arch);
    try {
      const availability = await harness.availability();
      for (const [name, requirement] of HOST_RESTRICTED_TOOLS) {
        const supported =
          platform === "linux" && (requirement === "linux" || arch === "x64");
        const entry = availability.find((tool) => tool.name === name);
        if (!supported)
          expect(entry, name).toMatchObject({
            available: false,
            reason: "unsupported_host",
          });
        else if (name === "inspect_evm_interface")
          // The configured limiter is absent; the host itself is supported.
          expect(entry, name).toMatchObject({
            available: false,
            reason: "provider_missing",
          });
        else expect(entry, name).toMatchObject({ available: true });
      }
    } finally {
      await harness.close();
    }
  },
);

it.each([
  ["the observed host", "darwin", "arm64", {}],
  [
    "the caller",
    "linux",
    "x64",
    { hostUnsupported: { signalRecording: true } },
  ],
] as const)(
  "keeps a host restriction from %s under a configured availability policy",
  async (_source, platform, arch, restriction) => {
    const harness = await connect(platform, arch, {
      availabilityPolicy: () => ({
        processCaptureEnabled: true,
        signalRecordingEnabled: true,
        ...restriction,
      }),
    });
    try {
      expect(
        (await harness.availability()).find(
          (tool) => tool.name === "decode_signal_recording",
        ),
      ).toMatchObject({ available: false, reason: "unsupported_host" });
    } finally {
      await harness.close();
    }
  },
);

it("refuses execution on the hosts that discovery reports unsupported", async () => {
  const harness = await connect("darwin", "arm64");
  try {
    for (const [name, args] of [
      ["inspect_signal_decoders", {}],
      ["inspect_binary_layout", { path: harness.path("runtime.hex") }],
      [
        "inspect_evm_interface",
        { path: harness.path("runtime.hex"), encoding: "hex" },
      ],
    ] as const)
      expect(await harness.call(name, args), name).toMatchObject({
        error: { code: "capability_unavailable", retryable: false },
      });
  } finally {
    await harness.close();
  }
});

it("gates execution of the default providers by the server's selected host", async () => {
  // One of the two hosts differs from the runner's, so each provider refuses
  // differently under them only if composition forwards the selected host.
  const unsupported = await connect("darwin", "arm64");
  const supported = await connect("linux", "x64");
  try {
    for (const name of [
      "inspect_firmware_regions",
      "recover_javascript_sources",
      "inspect_packet_fields",
      "inspect_signal_decoders",
      "inspect_evm_interface",
    ] as const) {
      const args = (harness: typeof supported) =>
        name === "inspect_packet_fields" || name === "inspect_signal_decoders"
          ? {}
          : name === "recover_javascript_sources"
            ? {
                path: harness.path("input.js"),
                output_directory: harness.path("recovered"),
              }
            : name === "inspect_evm_interface"
              ? { path: harness.path("runtime.hex"), encoding: "hex" }
              : { path: harness.path("firmware.bin") };
      const refused = await unsupported.call(name, args(unsupported));
      expect(refused, name).toMatchObject({
        error: { code: "capability_unavailable", retryable: false },
      });
      const admitted = await supported.call(name, args(supported));
      expect(
        (admitted as { error?: { message?: unknown } }).error?.message,
        name,
      ).not.toBe((refused as { error: { message: unknown } }).error.message);
    }
  } finally {
    await Promise.all([unsupported.close(), supported.close()]);
  }
});

it.each([
  ["win32", false],
  ["linux", true],
] as const)(
  "reports process capture on a selected %s host as its plan admits it",
  async (platform, admitted) => {
    const harness = await connect(platform, "x64");
    try {
      const entry = (await harness.availability()).find(
        (tool) => tool.name === "capture_process_scenario",
      );
      expect(entry?.available).toBe(admitted);
      const planned = await harness.call("capture_process_scenario", {
        executable: process.execPath,
        working_directory: harness.path("."),
        dry_run: true,
      });
      if (admitted) expect(planned).not.toHaveProperty("error");
      else
        expect(planned).toMatchObject({
          error: { code: "capability_unavailable" },
        });
    } finally {
      await harness.close();
    }
  },
);
