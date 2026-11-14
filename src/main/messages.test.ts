import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  MCP_CONNECTION_LOST,
  MCP_CONNECTION_START_FAILED,
  MCP_TRANSPORT_ERROR,
  MCP_VALIDATION_FAILED,
  SERVER_START_FAILED,
} from "./messages.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
it("publishes the canonical recovery messages in the error catalog", async () => {
  const catalog = await readFile(
    join(root, "docs/user-visible-errors.csv"),
    "utf8",
  );
  for (const message of [
    MCP_CONNECTION_LOST,
    MCP_CONNECTION_START_FAILED,
    MCP_TRANSPORT_ERROR,
    MCP_VALIDATION_FAILED,
    SERVER_START_FAILED,
  ])
    expect(catalog).toContain(message);
});
