import { expect, it } from "vitest";

import { parseBinaryTarget } from "../BinaryTargetResolver.js";
import type {
  AnalysisProvider,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { LazyAnalysisProvider } from "./LazyAnalysisProvider.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { ok as resultOk } from "../../domain/result.js";

const identity: ProviderIdentity = {
  id: "test-provider",
  name: "Test provider",
  version: "1",
};

const providerWithClient = (
  onCreate: () => void = () => undefined,
): AnalysisProvider => ({
  identity: () => identity,
  capabilities: () => [],
  createClient: () => {
    onCreate();
    return {
      execute: async () => resultOk(createAnalysisExecution(null, identity)),
      close: async () => resultOk(null),
    };
  },
});

const target = async () => {
  const parsed = await parseBinaryTarget(process.execPath);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

it("returns a tagged provider error when lazy loading fails", async () => {
  const provider = new LazyAnalysisProvider({
    identity,
    capabilities: [],
    load: async () => {
      throw new Error("provider module unavailable");
    },
  });

  const result = await provider
    .createClient(await target())
    .execute("health", {});

  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      providerId: "test-provider",
      operation: "health",
    },
  });
});

it("joins a cancelled unabortable module load and refuses late client acquisition", async () => {
  let finishLoading!: (provider: AnalysisProvider) => void;
  let enter!: () => void;
  let creates = 0;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const provider = new LazyAnalysisProvider({
    identity,
    capabilities: [],
    load: () => {
      enter();
      return new Promise((resolve) => {
        finishLoading = resolve;
      });
    },
  });
  const controller = new AbortController();
  const reason = { request: "cancel during import" };
  const client = provider.createClient(await target());
  let settled = false;
  const pending = client
    .execute("health", {}, { signal: controller.signal })
    .then((value) => {
      settled = true;
      return value;
    });
  await entered;
  controller.abort(reason);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finishLoading(
      providerWithClient(() => {
        creates++;
      }),
    );
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "health" },
    });
    if (result.ok) throw new Error("Cancellation unexpectedly succeeded");
    expect(result.error.cause).toBe(reason);
    expect(creates).toBe(0);
    expect(await client.close()).toEqual(resultOk(null));
  } finally {
    finishLoading(providerWithClient());
    await pending;
    await client.close();
  }
});

it("reports that a lazy client was closed before its first operation", async () => {
  const provider = new LazyAnalysisProvider({
    identity,
    capabilities: [],
    load: async () => providerWithClient(),
  });
  const client = provider.createClient(await target());
  await client.close();

  expect(await client.execute("health", {})).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      operation: "health",
      diagnostics: { reason: "client_closed" },
    },
  });
});
