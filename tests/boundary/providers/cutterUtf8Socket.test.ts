import type { Socket } from "node:net";
import { chmod } from "node:fs/promises";
import { expect, it } from "vitest";
import { CutterBridgeClient } from "../../../src/cutter/CutterBridgeClient.js";
import {
  authenticatedServer,
  writeDescriptor,
} from "../../fixtures/cutterBridgeProtocol.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const TOKEN = "inert-cutter-wire-token-0123456789";
const malformed = (bytes: Buffer): Buffer => {
  const marker = Buffer.from("�");
  const at = bytes.indexOf(marker);
  if (at < 0) throw new Error("Missing independently encoded literal marker");
  return Buffer.concat([
    bytes.subarray(0, at),
    Buffer.from([0xff]),
    bytes.subarray(at + marker.length),
  ]);
};

it.each([
  { phase: "challenge", invalid: true, failed: false },
  { phase: "challenge", invalid: false, failed: false },
  { phase: "response", invalid: true, failed: false },
  { phase: "response", invalid: false, failed: false },
  { phase: "response", invalid: false, failed: true },
  { phase: "disconnect", invalid: false, failed: false },
])(
  "preserves Cutter wire facts for $phase (malformed: $invalid; failed: $failed)",
  async ({ phase, invalid, failed }) => {
    const root = await createTestTempDirectory("rea-cutter-utf8-wire-");
    await chmod(root, 0o700);
    let commands = 0;
    let acknowledgements = 0;
    const sockets = new Set<Socket>();
    const closed: Promise<void>[] = [];
    const peer = authenticatedServer(
      TOKEN,
      SESSION,
      (request, respond, connection) => {
        if (request.kind === "ack") {
          acknowledgements++;
          respond({ ok: true, acknowledged: true });
          return;
        }
        commands++;
        if (phase === "disconnect") {
          connection.destroy();
          return;
        }
        if (phase === "response" && invalid) {
          // Preserve the existing peer's real HMAC over its logical payload, but
          // replace one encoded scalar with a malformed byte on the socket wire.
          const end = connection.end.bind(connection);
          connection.end = (chunk: unknown) => {
            if (typeof chunk !== "string" && !(chunk instanceof Uint8Array))
              throw new Error("Unexpected fake-peer end shape");
            return end(malformed(Buffer.from(chunk)));
          };
        }
        respond({
          ok: !failed,
          execution_state: failed ? "failed" : "complete",
          output: "literal �",
          ...(failed
            ? {
                error: "inert-command-failed",
                message: "independent protocol failure �",
              }
            : {}),
        });
      },
    );
    peer.on("connection", (connection) => {
      sockets.add(connection);
      closed.push(
        new Promise<void>((resolve) =>
          connection.once("close", () => {
            sockets.delete(connection);
            resolve();
          }),
        ),
      );
      connection.on("error", () => {});
      if (phase === "challenge") {
        const write = connection.write.bind(connection);
        connection.write = (chunk: unknown) => {
          if (typeof chunk !== "string")
            throw new Error("Unexpected fake-peer challenge shape");
          const value: Record<string, unknown> = JSON.parse(chunk);
          const bytes = Buffer.from(
            JSON.stringify({ ...value, note: "literal �" }) + "\n",
          );
          return write(invalid ? malformed(bytes) : bytes);
        };
      }
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const address = peer.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing private socket endpoint");
    await writeDescriptor(root, SESSION, address.port, TOKEN);
    const client = new CutterBridgeClient({ REA_CUTTER_BRIDGE_DIR: root });
    try {
      const pending = client.execute({
        sessionId: SESSION,
        expectedGeneration: 0,
        command: "inert-read-command",
        json: false,
      });
      if (phase === "challenge" && invalid) {
        await expect(pending).rejects.toMatchObject({
          _tag: "AnalysisCapabilityUnavailableError",
        });
        expect(commands).toBe(0);
      } else {
        const execution = await pending;
        if (invalid || phase === "disconnect") {
          expect(execution).toMatchObject({
            executionState: "unknown",
            output: null,
            error: "transport-response-missing",
          });
          expect(acknowledgements).toBe(0);
        } else {
          expect(execution).toMatchObject({
            executionState: failed ? "failed" : "complete",
            output: "literal �",
            error: failed ? "inert-command-failed" : null,
          });
          expect(acknowledgements).toBe(1);
        }
        expect(commands).toBe(1);
      }
      await Promise.all(closed);
      expect(sockets.size).toBe(0);
    } finally {
      await client.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all(closed);
      await new Promise<void>((resolve, reject) =>
        peer.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  },
);
