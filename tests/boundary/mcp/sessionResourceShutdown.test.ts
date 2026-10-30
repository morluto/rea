import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { expect, it, vi } from "vitest";

import { ProcessCaptureResourceScope } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

it("reports both process and snapshot cleanup rejections when the transport closes", async () => {
  const logs: string[] = [];
  const processFailure = new Error("controlled process cleanup failure");
  const fileFailure = new ProviderCleanupError("rea", ["snapshot.json"], {
    reason: "controlled snapshot cleanup failure",
  });
  const session = createTestBinarySession(createCacheProvider([]));
  // No capture or snapshot was opened; inject the two independent close failures.
  const processClose = vi
    .spyOn(ProcessCaptureResourceScope.prototype, "close")
    .mockRejectedValue(processFailure);
  const fileClose = vi
    .spyOn(session, "closeFileResources")
    .mockResolvedValue(err(fileFailure));
  const server = createServer(
    { kind: "session", session },
    { logger: pino({}, { write: (line) => logs.push(line) }) },
  );
  const client = new Client({ name: "cleanup-reporting", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.close();
    await vi.waitFor(() => {
      const failures = logs.map(
        (line) => JSON.parse(line) as { error?: string },
      );
      expect(failures.map(({ error }) => error)).toEqual(
        expect.arrayContaining([processFailure.message, fileFailure.message]),
      );
    });
  } finally {
    processClose.mockRestore();
    fileClose.mockRestore();
    await client.close();
    await server.close();
    await session.close();
  }
});
