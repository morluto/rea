import { createHash } from "node:crypto";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../../../src/contracts/managed/managedWorkflowExamples.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/domain/processCaptureExample.js";
import {
  managedNativeVerificationInputSchema,
  managedNativeVerificationResultSchema,
  verifyManagedNativeBoundaries,
} from "../../../src/domain/managed/managedNativeVerification.js";
import { nativeUiResultSchema } from "../../../src/domain/native/nativeUiObservation.js";
import { processCaptureSchema } from "../../../src/domain/processCapture.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a schema object");
  return value as Record<string, unknown>;
};

it("advertises semantic output invariants and keeps producers aligned with Zod", async () => {
  const contracts = [
    toolContract("capture_native_ui_scenario"),
    toolContract("capture_process_scenario"),
    toolContract("verify_managed_native_boundaries"),
  ];
  const server = new McpServer({
    name: "output-schema-semantics",
    version: "1",
  });
  const client = new Client({ name: "output-schema-semantics", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  for (const contract of contracts)
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () => ({ content: [] }),
    );

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = new Map(
      (await client.listTools()).tools.map((tool) => [tool.name, tool]),
    );
    const outputResultSchema = (name: (typeof contracts)[number]["name"]) => {
      const tool = advertised.get(name);
      if (tool?.outputSchema === undefined)
        throw new Error(`${name} output schema missing`);
      const outputSchema = record(tool.outputSchema);
      const result = record(record(outputSchema.properties).result);
      const standaloneResultSchema = z.record(z.string(), z.unknown()).parse({
        ...result,
        ...(typeof outputSchema.$schema === "string"
          ? { $schema: outputSchema.$schema }
          : {}),
        ...(outputSchema.$defs === undefined
          ? {}
          : { $defs: outputSchema.$defs }),
      });
      return {
        result,
        validate: new Ajv2020({
          strict: false,
          validateFormats: false,
        }).compile(standaloneResultSchema),
      };
    };

    const native = outputResultSchema("capture_native_ui_scenario");
    const initial = record(record(native.result.properties).initial);
    const screenshotUnion = record(record(initial.properties).screenshot);
    const screenshotVariants = screenshotUnion.anyOf;
    if (!Array.isArray(screenshotVariants))
      throw new Error("Expected nullable screenshot schema");
    const screenshotProperties = record(
      record(screenshotVariants[0]).properties,
    );
    expect(record(screenshotProperties.base64).description).toContain(
      "PNG signature",
    );
    expect(record(screenshotProperties.sha256).description).toContain(
      "decoded PNG bytes",
    );
    const pngBytes = Buffer.from("not a PNG");
    const invalidScreenshot = {
      target_sha256: "a".repeat(64),
      initial: {
        window: {
          pid: 1,
          window_id: 1,
          executable: "app",
          launch_time: 0,
          title: "",
        },
        nodes: [],
        truncated: false,
        screenshot: {
          mime_type: "image/png",
          base64: pngBytes.toString("base64"),
          sha256: createHash("sha256").update(pngBytes).digest("hex"),
          width: 1,
          height: 1,
        },
        gaps: [],
      },
      steps: [],
      restore: "leave-as-is",
      limitations: [],
    };
    expect(native.validate(invalidScreenshot)).toBe(true);
    expect(nativeUiResultSchema.safeParse(invalidScreenshot).success).toBe(
      false,
    );

    const process = outputResultSchema("capture_process_scenario");
    expect(process.result.description).toContain("canonical scenario");
    expect(process.result.description).toContain(
      "older input without an event journal",
    );
    const validCapture = processCaptureSchema.parse(
      EMPTY_PROCESS_CAPTURE_EXAMPLE,
    );
    expect(validCapture.event_journal).toEqual([]);
    expect(process.validate(validCapture)).toBe(true);
    expect(
      processCaptureSchema.safeParse(EMPTY_PROCESS_CAPTURE_EXAMPLE).success,
    ).toBe(true);
    const invalidCapture = {
      ...validCapture,
      manifest: {
        ...validCapture.manifest,
        full_scenario_sha256: "0".repeat(64),
      },
    };
    expect(process.validate(invalidCapture)).toBe(true);
    expect(processCaptureSchema.safeParse(invalidCapture).success).toBe(false);

    const managed = outputResultSchema("verify_managed_native_boundaries");
    expect(managed.result.description).toContain(
      "accepted plus unsupported equals total",
    );
    const validVerification = verifyManagedNativeBoundaries(
      managedNativeVerificationInputSchema.parse(
        MANAGED_NATIVE_VERIFICATION_EXAMPLE,
      ),
    );
    expect(managed.validate(validVerification)).toBe(true);
    const invalidVerification = structuredClone(validVerification);
    invalidVerification.summary.verified += 1;
    expect(managed.validate(invalidVerification)).toBe(true);
    expect(
      managedNativeVerificationResultSchema.safeParse(invalidVerification)
        .success,
    ).toBe(false);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});
