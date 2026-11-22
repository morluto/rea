import { cliCommand } from "../../../src/cli/commandRegistry.js";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { z } from "zod";
import pino from "pino";
import { expect, it } from "vitest";

import {
  registerContractCommand,
  registerContractDocumentCommand,
} from "../../../src/cli/contractCommand.js";
import type { CliInstance } from "../../../src/cli/types.js";

const viewSchema = z.strictObject({ page: z.number().int() }).optional();
const detailSchema = z.enum(["complete", "summary"]).default("complete");

/**
 * Probe commands for each shape that takes `--view`: argv fields, argv fields
 * whose view selects summary delivery, and one JSON document. Each handler
 * counts as opening its target.
 */
const harness = () => {
  const cli = createCommandCli();
  const opened: string[] = [];
  const logger = pino({ enabled: false });
  const target = {
    name: "view_probe",
    inputSchema: z.object({
      path: z.string(),
      detail: detailSchema,
      view: viewSchema,
    }),
  };
  registerContractCommand(
    cli as unknown as CliInstance,
    logger,
    target,
    {
      command: "argv",
      description: "Argv",
      positionals: ["path"],
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
    },
    async () => {
      opened.push("argv");
      return {};
    },
  );
  registerContractCommand(
    cli as unknown as CliInstance,
    logger,
    target,
    {
      command: "selects-summary",
      description: "Selects summary",
      positionals: ["path"],
      evidenceDelivery: true,
      viewDelivery: {
        invalidJson: "view must be valid JSON",
        viewSelectsSummary: true,
      },
    },
    async () => {
      opened.push("selects-summary");
      return {};
    },
  );
  registerContractCommand(
    cli as unknown as CliInstance,
    logger,
    {
      name: "view_json_input_probe",
      inputSchema: z.object({
        path: z.string(),
        settings: z.record(z.string(), z.number()).optional(),
        detail: detailSchema,
        view: viewSchema,
      }),
    },
    {
      command: "json-input",
      description: "JSON input",
      positionals: ["path"],
      jsonInputs: { settings: "settings must be inline JSON or a file" },
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
    },
    async () => {
      opened.push("json-input");
      return {};
    },
  );
  registerContractDocumentCommand(
    cli as unknown as CliInstance,
    logger,
    {
      name: "view_document_probe",
      inputSchema: z.object({
        capture: z.string(),
        detail: detailSchema,
        view: viewSchema,
      }),
    },
    {
      command: "document",
      description: "Document",
      document: "Capture document",
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
    },
    async () => {
      opened.push("document");
      return {};
    },
  );
  const invoke = async (
    command: string,
    args: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    const registered = cliCommand(cli, command)?.definition;
    if (registered === undefined) throw new Error(`${command} is missing`);
    const parse = (key: "args" | "options", value: unknown) =>
      (Reflect.get(registered, key) as { parse(v: unknown): unknown }).parse(
        value,
      );
    const run = Reflect.get(registered, "run") as (
      value: unknown,
    ) => Promise<unknown>;
    // A refused command sets the shared worker's exit status; restore it.
    const exitCode = process.exitCode;
    try {
      return await run({
        args: parse("args", args),
        options: parse("options", options),
      });
    } finally {
      process.exitCode = exitCode;
    }
  };
  return { invoke, opened };
};

const viewRefusal = {
  code: "invalid_request",
  details: { issues: [{ path: ["view"], reason: "invalid_value" }] },
};

const view = JSON.stringify({ page: 1 });

it.each([
  ["argv", { path: "/missing" }, { view }],
  ["argv", { path: "/missing" }, { view, detail: "complete" }],
  [
    "argv",
    { path: "/missing" },
    { view, detail: "complete", evidence_output: "/missing.bundle.json" },
  ],
  ["selects-summary", { path: "/missing" }, { view, detail: "complete" }],
  ["document", { inputJson: '{"capture":"c"}' }, { view }],
  ["document", { inputJson: '{"capture":"c"}' }, { view, detail: "complete" }],
])(
  "%s refuses a view without summary delivery before opening its target (%j %j)",
  async (command, args, options) => {
    const { invoke, opened } = harness();
    await expect(invoke(command, args, options)).resolves.toMatchObject(
      viewRefusal,
    );
    expect(opened).toEqual([]);
  },
);

it.each([
  ["argv", { path: "/missing" }],
  ["selects-summary", { path: "/missing" }],
  ["document", { inputJson: '{"capture":"c"}' }],
])("%s admits a view with summary delivery", async (command, args) => {
  const { invoke, opened } = harness();
  await invoke(command, args, {
    view,
    detail: "summary",
    evidence_output: "/missing.bundle.json",
  });
  expect(opened).toEqual([command]);
});

// A JSON input may name a file or stdin; reading it must not delay the
// refusal of options the invocation can never use.
it.each([
  [{ view: "{" }, { path: ["view"], reason: "invalid_format" }],
  [{ view }, { path: ["view"], reason: "invalid_value" }],
  [
    { detail: "summary" },
    { path: ["evidence_output"], reason: "invalid_value" },
  ],
])(
  "refuses delivery options before reading a JSON input (%j)",
  async (options, issue) => {
    const { invoke, opened } = harness();
    await expect(
      invoke(
        "json-input",
        { path: "/missing" },
        { ...options, settings: "/missing/settings.json" },
      ),
    ).resolves.toMatchObject({
      code: "invalid_request",
      details: { issues: [issue] },
    });
    expect(opened).toEqual([]);
  },
);
