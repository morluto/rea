import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "../../../src/contracts/browserScenarioToolContracts.js";
import { BROWSER_TOOL_CONTRACTS } from "../../../src/contracts/browserToolContracts.js";
import { WEB_NETWORK_CAPTURE_TOOL_CONTRACTS } from "../../../src/contracts/webNetworkCaptureToolContracts.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import {
  applicationToolRegistrationOptions,
  toolRegistrationOptions,
} from "../../../src/server/toolRegistrationOptions.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

/** Only the named families these focused tests exercise. */
const TESTED_CONTRACTS = [
  ...BROWSER_SCENARIO_TOOL_CONTRACTS,
  ...BROWSER_TOOL_CONTRACTS,
  ...WEB_NETWORK_CAPTURE_TOOL_CONTRACTS,
] as const;

type TestedContract = (typeof TESTED_CONTRACTS)[number];
type TestedToolName = TestedContract["name"];

/** Resolve a tested contract by operation name, never by catalog position. */
const contractNamed = <Name extends TestedToolName>(
  name: Name,
): Extract<TestedContract, { readonly name: Name }> => {
  const contract = TESTED_CONTRACTS.find(
    (
      candidate,
    ): candidate is Extract<TestedContract, { readonly name: Name }> =>
      candidate.name === name,
  );
  if (contract === undefined) throw new Error(`Missing tool contract: ${name}`);
  return contract;
};

/** Deliver every top-level structured argument as the JSON text clients send. */
const asJsonTextArguments = (
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(input).map(([argument, supplied]) =>
      supplied !== null && typeof supplied === "object"
        ? [argument, JSON.stringify(supplied)]
        : [argument, supplied],
    ),
  );

const connect = async (
  register: (
    server: EvidenceMcpServer,
    record: (input: unknown) => void,
  ) => void,
  maximumInputElements?: number,
): Promise<{ client: Client; calls: unknown[] }> => {
  const calls: unknown[] = [];
  const server = new EvidenceMcpServer(
    { name: "stringified-arguments", version: "1" },
    {
      capabilities: {},
      ...(maximumInputElements === undefined
        ? {}
        : { maxToolInputElements: maximumInputElements }),
    },
    undefined,
    createToolResultDelivery(undefined),
  );
  register(server, (input) => calls.push(input));
  const client = new Client({ name: "stringified-arguments", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls };
};

/** Register a contract with its canonical input but no output contract. */
const registerContractTool = (
  server: EvidenceMcpServer,
  name: TestedToolName,
  record: (input: unknown) => void,
): void => {
  const { outputSchema: _contractOutput, ...config } = toolRegistrationOptions(
    contractNamed(name),
  );
  server.registerTool(name, config, (input: unknown) => {
    record(input);
    return { content: [] };
  });
};

/** Register an application-validated contract without its output schema. */
const registerApplicationTool = (
  server: EvidenceMcpServer,
  name: TestedToolName,
  record: (input: unknown) => void,
): void => {
  const { outputSchema: _contractOutput, ...config } =
    applicationToolRegistrationOptions(contractNamed(name));
  server.registerTool(name, config, (input: unknown) => {
    record(input);
    return { content: [] };
  });
};

describe("stringified structured tool arguments", () => {
  it("recovers structured arguments a client delivered as JSON text", async () => {
    const example = contractNamed("capture_browser_scenario").examples[0].input;
    const supplied = asJsonTextArguments(example);
    expect(supplied).not.toEqual(example);
    const { client, calls } = await connect((server, record) =>
      registerContractTool(server, "capture_browser_scenario", record),
    );

    await client.callTool({
      name: "capture_browser_scenario",
      arguments: supplied,
    });

    expect(calls[0]).toMatchObject({
      browser: example["browser"],
      start_url: example["start_url"],
      actions: example["actions"],
    });
  });

  it("recovers an array argument on inspect_web_page", async () => {
    const example = contractNamed("inspect_web_page").examples[0].input;
    const supplied = {
      ...example,
      allowed_origins: JSON.stringify(["https://example.com"]),
    };
    const { client, calls } = await connect((server, record) =>
      registerContractTool(server, "inspect_web_page", record),
    );

    await client.callTool({ name: "inspect_web_page", arguments: supplied });

    expect(calls[0]).toMatchObject({
      allowed_origins: ["https://example.com"],
      target_id: example["target_id"],
    });
  });

  it("keeps JSON text a string parameter accepts as the caller sent it", async () => {
    const jsonText = '{"origin":"https://example.com"}';
    const { client, calls } = await connect((server, record) => {
      server.registerTool(
        "record_note",
        { inputSchema: z.object({ note: z.string() }) },
        (input) => {
          record(input);
          return { content: [] };
        },
      );
    });

    await client.callTool({
      name: "record_note",
      arguments: { note: jsonText },
    });

    expect(calls[0]).toEqual({ note: jsonText });
  });

  it("keeps JSON-looking strings intact on application-validated registrations", async () => {
    const { client, calls } = await connect((server, record) =>
      registerApplicationTool(server, "inspect_web_network_capture", record),
    );

    await client.callTool({
      name: "inspect_web_network_capture",
      arguments: { capture_path: "[]" },
    });

    expect(calls[0]).toEqual({ capture_path: "[]" });
  });

  it("recovers structured arguments on application-validated registrations", async () => {
    const { client, calls } = await connect((server, record) =>
      registerApplicationTool(server, "inspect_web_network_capture", record),
    );

    await client.callTool({
      name: "inspect_web_network_capture",
      arguments: {
        capture_path: "/captures/session.har",
        format: "har",
        record_ordinals: "[0]",
      },
    });

    expect(calls[0]).toMatchObject({
      capture_path: "/captures/session.har",
      format: "har",
      record_ordinals: [0],
    });
  });

  it("keeps application-owned failures on the caller's original arguments", async () => {
    const { client, calls } = await connect((server, record) =>
      registerApplicationTool(server, "inspect_web_network_capture", record),
    );

    await client.callTool({
      name: "inspect_web_network_capture",
      arguments: {
        capture_path: "/captures/session.har",
        format: "har",
        record_ordinals: '{"0":0}',
      },
    });

    expect(calls[0]).toMatchObject({
      capture_path: "/captures/session.har",
      format: "har",
      record_ordinals: '{"0":0}',
    });
  });
});

describe("stringified argument admission and diagnostics", () => {
  it("charges JSON-text arrays against the selected element allowance", async () => {
    const { client, calls } = await connect((server, record) => {
      server.registerTool(
        "capacity_probe",
        { inputSchema: z.strictObject({ values: z.array(z.number()) }) },
        (input) => {
          record(input);
          return { content: [] };
        },
      );
    }, 8);

    const nativeWithin = await client.callTool({
      name: "capacity_probe",
      arguments: { values: [1, 2, 3, 4, 5, 6, 7] },
    });
    expect(nativeWithin.isError).not.toBe(true);
    expect(calls).toHaveLength(1);

    const nativeOver = await client.callTool({
      name: "capacity_probe",
      arguments: { values: Array.from({ length: 16 }, (_, index) => index) },
    });
    expect(parseMcpToolError(nativeOver).error).toMatchObject({
      code: "resource_constraint",
      details: { reported_limits: { max_input_elements: 8 } },
    });

    const textOver = await client.callTool({
      name: "capacity_probe",
      arguments: {
        values: JSON.stringify(Array.from({ length: 16 }, (_, index) => index)),
      },
    });
    expect(parseMcpToolError(textOver).error).toMatchObject({
      code: "resource_constraint",
      details: { reported_limits: { max_input_elements: 8 } },
    });
    expect(calls).toHaveLength(1);
  });

  it("charges JSON-text arrays on application-validated registrations", async () => {
    const { client, calls } = await connect((server, record) => {
      registerApplicationTool(server, "inspect_web_network_capture", record);
    }, 8);

    const within = await client.callTool({
      name: "inspect_web_network_capture",
      arguments: {
        capture_path: "/captures/session.har",
        format: "har",
        record_ordinals: [0, 1, 2, 3, 4],
      },
    });
    expect(within.isError).not.toBe(true);
    expect(calls).toHaveLength(1);

    const textOver = await client.callTool({
      name: "inspect_web_network_capture",
      arguments: {
        capture_path: "/captures/session.har",
        format: "har",
        record_ordinals: JSON.stringify([0, 1, 2, 3, 4, 5]),
      },
    });
    expect(parseMcpToolError(textOver).error).toMatchObject({
      code: "resource_constraint",
      details: { reported_limits: { max_input_elements: 8 } },
    });
    expect(calls).toHaveLength(1);
  });

  it("reports recovered-field failures against the rejected structure", async () => {
    const example = contractNamed("capture_browser_scenario").examples[0].input;
    const { client } = await connect((server, record) =>
      registerContractTool(server, "capture_browser_scenario", record),
    );

    const result = await client.callTool({
      name: "capture_browser_scenario",
      arguments: {
        ...example,
        actions: JSON.stringify([
          {
            step_id: "settle",
            action: "wait_for_timeout",
            duration_ms: "250",
          },
        ]),
      },
    });

    const { error } = parseMcpToolError(result);
    expect(error.code).toBe("invalid_request");
    expect(error.details?.issues).toContainEqual(
      expect.objectContaining({
        path: ["actions", 0, "duration_ms"],
        reason: "invalid_type",
      }),
    );
  });

  it("still rejects structured text that is not JSON", async () => {
    const example = contractNamed("capture_browser_scenario").examples[0].input;
    const { client } = await connect((server, record) =>
      registerContractTool(server, "capture_browser_scenario", record),
    );

    const result = await client.callTool({
      name: "capture_browser_scenario",
      arguments: { ...example, actions: '["unterminated' },
    });

    const { error } = parseMcpToolError(result);
    expect(error.code).toBe("invalid_request");
    expect(error.details?.issues).toContainEqual(
      expect.objectContaining({ path: ["actions"], reason: "invalid_type" }),
    );
  });
});
