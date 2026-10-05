import { expect, it } from "vitest";

import { parseBinaryTarget } from "./BinaryTargetResolver.js";
import type { AnalysisProvider, ProviderIdentity } from "./AnalysisProvider.js";
import { LazyAnalysisProvider } from "./LazyAnalysisProvider.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { err } from "../domain/result.js";

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
      execute: async (operation) => err(new AnalysisCancelledError(operation)),
      close: async () => undefined,
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

it("returns cancellation while an unabortable lazy load continues safely", async () => {
  let finishLoading: ((provider: AnalysisProvider) => void) | undefined;
  let markCreated: (() => void) | undefined;
  const created = new Promise<void>((resolve) => {
    markCreated = resolve;
  });
  const provider = new LazyAnalysisProvider({
    identity,
    capabilities: [],
    load: () =>
      new Promise<AnalysisProvider>((resolve) => {
        finishLoading = resolve;
      }),
  });
  const controller = new AbortController();
  const client = provider.createClient(await target());
  const pending = client.execute("health", {}, { signal: controller.signal });

  await Promise.resolve();
  controller.abort();
  expect(await pending).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError", operation: "health" },
  });

  finishLoading?.(providerWithClient(() => markCreated?.()));
  await created;
  await client.close();
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
