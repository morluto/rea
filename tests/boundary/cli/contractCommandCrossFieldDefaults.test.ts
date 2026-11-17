import { expect, it } from "vitest";
import { registerCaptureCommands } from "../../../src/cli/captureCommands.js";
import { contractCommandDescriptions } from "../../../src/cli/contractCommand.js";
import { registerSignalCommands } from "../../../src/cli/signalCommands.js";
import { registerSqliteCommands } from "../../../src/cli/sqliteCommands.js";
import { silentLogger } from "../../../src/logger.js";
import { createCommandCli } from "../../support/cli/commandCli.js";

const cli = createCommandCli();
registerCaptureCommands(cli, silentLogger, {});
registerSignalCommands(cli, silentLogger, {});
registerSqliteCommands(cli, silentLogger, {});

it.each([
  { command: "inspect-packet-capture", options: { fields: ["ip.addr"] } },
  { command: "decode-signal-recording", options: { decoders: "uart" } },
  { command: "inspect-sqlite-database", options: {} },
])(
  "$command resolves defaults only for cross-field checks and preserves caller omission",
  ({ command, options }) => {
    const description = contractCommandDescriptions(cli).find(
      (candidate) => candidate.command === command,
    );
    if (description === undefined)
      throw new Error(`Missing command ${command}`);
    // These JSON strings are decoded when the command runs, after argv checks.
    // Checking defaults must not reparse already-admitted option values.
    const limits = description.parameters.find(
      (parameter) => parameter.field === "producer_limits",
    );
    const text = '{"input_bytes":1024}';
    const values =
      limits === undefined ? options : { ...options, [limits.key]: text };
    expect(description.checkOptions?.(values)).toEqual([]);
    expect(description.toContractInput(values)).toEqual(
      limits === undefined ? options : { ...options, producer_limits: text },
    );
  },
);
