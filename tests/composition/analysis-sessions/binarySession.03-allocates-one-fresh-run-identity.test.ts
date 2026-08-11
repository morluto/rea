import { describe, expect, it } from "vitest";

import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

describe("binary session", () => {
  it("allocates one fresh run identity per provider client lifetime", async () => {
    const [first, second] = await createBinarySessionTargets();
    const provider = createCacheProvider([]);
    const createClient = provider.createClient.bind(provider);
    const runIds: string[] = [];
    provider.createClient = (target, profile, context) => {
      if (context === undefined)
        throw new Error("missing analysis run context");
      runIds.push(context.runId);
      return createClient(target, profile, context);
    };
    const session = createTestBinarySession(provider);

    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(second)).ok).toBe(true);

    expect(runIds).toHaveLength(2);
    expect(new Set(runIds).size).toBe(2);
    await session.close();
  });
});
