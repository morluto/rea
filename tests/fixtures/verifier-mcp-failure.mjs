import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.env.REA_TEST_EXIT_MARKER;
const mode = process.env.REA_TEST_FAILURE_MODE;
if (!marker || !mode) throw new Error("Missing verifier fixture configuration");
const keepAlive = setInterval(() => {}, 1000);
// The test harness selects its own temporary exit marker.
process.on("exit", () => writeFileSync(marker, "exited"));
process.stdin.on("end", () => clearInterval(keepAlive));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize" && mode !== "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "verifier-failure-fixture", version: "1" },
        },
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: `intentional ${mode} failure` },
    })}\n`,
  );
});
