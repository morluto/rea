import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createV8CodeCacheService } from "../composition/v8CodeCache.js";
import { V8_CODE_CACHE_TOOL_CONTRACTS } from "../contracts/v8/v8CodeCacheToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Inspect operator-selected V8 code caches through the same shared workflow as MCP. */
export const registerV8CodeCacheCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const contract = contractNamed(
    V8_CODE_CACHE_TOOL_CONTRACTS,
    "inspect_v8_code_cache",
  );
  registerContractCommand(
    cli,
    logger,
    contract,
    {
      command: CLI_COMMANDS.inspectV8CodeCache,
      description:
        "Inspect a V8 code cache header and its embedded printable byte patterns without executing it",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local V8 code cache (.jsc) file" } },
    },
    inspectWithService(createV8CodeCacheService, "rea-v8-code-cache"),
  );
};
