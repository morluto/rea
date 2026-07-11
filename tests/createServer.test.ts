import { describe, expect, it } from "vitest";

import { ok } from "../src/domain/result.js";
import { createServer } from "../src/server/createServer.js";

const hopper = {
  callTool: () => Promise.resolve(ok(null)),
};

describe("beta.3 server composition", () => {
  it("constructs independent MCP server instances", () => {
    expect(createServer(hopper)).not.toBe(createServer(hopper));
  });
});
