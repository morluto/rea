import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { StructuredContentMcpClient } from "../providers/StructuredContentMcpClient.js";
import { AgentEnvComputer } from "./AgentEnvComputer.js";
import type { ComputerHelper } from "./AgentEnvComputerHelper.js";

it.each(["http", "invalid_json", "readiness"] as const)(
  "redacts the complete control token in %s failure diagnostics",
  async (failure) => {
    const token = "fake-control-token-keep-private-123456789";
    const status = failure === "http" ? 403 : 200;
    const ordinary =
      failure === "http" ? "x".repeat(500) : "ordinary target text";
    const body =
      failure === "readiness"
        ? JSON.stringify({
            ready: false,
            checks: [
              {
                name: "app",
                ok: false,
                final: true,
                detail: `${token} ${ordinary}`,
              },
            ],
          })
        : failure === "http"
          ? `${ordinary}${token}`
          : `${token} ${ordinary}`;
    const connect = vi
      .spyOn(StructuredContentMcpClient.prototype, "connect")
      .mockResolvedValue(undefined);
    const close = vi
      .spyOn(StructuredContentMcpClient.prototype, "close")
      .mockResolvedValue(undefined);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(body, { status }));
    try {
      const error = await AgentEnvComputer.connect(
        {
          handshake: async () => ({
            sandbox_id: "controlled-sandbox",
            base_url: "http://127.0.0.1:1",
            mcp_url: "http://127.0.0.1:1/mcp",
            control_token: token,
          }),
        } as unknown as ComputerHelper,
        new AbortController().signal,
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain(token.slice(0, 10));
      expect(error.message).toContain("[control tok");
      expect(error.message).toContain(ordinary.slice(0, 100));
      if (failure !== "readiness") {
        expect(error.cause).toBeInstanceOf(Error);
        expect(String(error.cause)).not.toContain(token.slice(0, 10));
      }
    } finally {
      fetch.mockRestore();
      close.mockRestore();
      connect.mockRestore();
    }
  },
);
it.each(["canonical", "missing", "rpc_error"] as const)(
  "validates recording replies and redacts their errors (%s)",
  async (answer) => {
    const present = answer === "canonical";
    const token = "fake-recording-control-token-123456789";
    const path = "rec-0123/0000.mp4";
    const homePath = `.agentenv-recordings/${path}`;
    const bytes = Buffer.from("controlled recording");
    const connect = vi
      .spyOn(StructuredContentMcpClient.prototype, "connect")
      .mockResolvedValue(undefined);
    const close = vi
      .spyOn(StructuredContentMcpClient.prototype, "close")
      .mockResolvedValue(undefined);
    const call = vi
      .spyOn(StructuredContentMcpClient.prototype, "callTool")
      .mockResolvedValue({ content: [] });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ready: true }))
      .mockResolvedValueOnce(
        Response.json(
          answer === "rpc_error"
            ? { error: { message: `${token} ordinary target text` } }
            : {
                result: {
                  parts: [
                    {
                      kind: "file",
                      file: { bytes: bytes.toString("base64") },
                      metadata: {
                        "urn:unrelated": {
                          path: present ? "wrong-path" : homePath,
                        },
                        ...(present
                          ? {
                              "urn:agentenv:data-objects/v1": {
                                path: homePath,
                              },
                            }
                          : {}),
                      },
                    },
                  ],
                },
              },
        ),
      );
    try {
      const { computer } = await AgentEnvComputer.connect(
        {
          handshake: async () => ({
            sandbox_id: "controlled-sandbox",
            base_url: "http://127.0.0.1:1",
            mcp_url: "http://127.0.0.1:1/mcp",
            control_token: token,
          }),
          release: async () => ({ verified: true, teardown: "agentenv" }),
        } as unknown as ComputerHelper,
        new AbortController().signal,
      );
      const read = computer.recordingSegments({
        recording_id: "rec-0123",
        segments: [
          {
            index: 0,
            path,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      });
      if (present) await expect(read).resolves.toEqual([{ path, bytes }]);
      else if (answer === "rpc_error") {
        const failure = await read.catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw failure;
        expect(failure.message).toContain("ordinary target text");
        expect(failure.message).toContain("[control token]");
        expect(failure.message).not.toContain(token);
      } else await expect(read).rejects.toThrow("missing or differs");
      await computer.close();
    } finally {
      fetch.mockRestore();
      call.mockRestore();
      close.mockRestore();
      connect.mockRestore();
    }
  },
);
