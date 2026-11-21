import { expect, it as test } from "vitest";
import { AnalysisSettings } from "../../../../src/application/AnalysisSettings.js";
import { parseConfig } from "../../../../src/config/parseConfig.js";
import { runtimeAnalysisConfig } from "../../../../src/config/runtimeAnalysisSettings.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { fakeKunaCalls } from "./fakeKuna.js";
import { session } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

it.each([
  ["REA_REGEX_MATCHING_DEADLINE_MS", "regex.matching_deadline_ms", 1000],
  ["REA_REGEX_WORKER_HEAP_REQUEST_MIB", "regex.worker_heap_request_mib", 128],
] as const)(
  "refuses invalid %s before acquisition, and honors override/reset",
  async (environmentName, setting, value) => {
    const { kuna, target, cacheRoot, profile } = await session(
      "rea-kuna-regex-admit-",
    );
    const environment = {
      REA_KUNA_COMMAND: kuna,
      REA_KUNA_CACHE_DIR: cacheRoot,
      [environmentName]: "invalid",
    };
    const settings = new AnalysisSettings(environment);
    const parsed = parseConfig(environment);
    if (!parsed.ok) throw parsed.error;
    const config = runtimeAnalysisConfig(parsed.value, settings.read);
    const provider = new KunaProvider(environment, {
      regexMatchingDeadline: config.regexMatchingDeadline,
      regexWorkerHeapRequest: config.regexWorkerHeapRequest,
    });
    const client = provider.createClient(target, profile);
    try {
      const before = await fakeKunaCalls(kuna);
      for (const operation of [
        "search_strings",
        "search_procedures",
      ] as const) {
        const invalid = await settings.run(() =>
          client.execute(operation, { pattern: "main", mode: "regex" }),
        );
        expect(invalid).toMatchObject({
          ok: false,
          error: { _tag: "ConfigurationError" },
        });
        const invalidInput = await settings.run(() =>
          client.execute(operation, { pattern: 7, mode: "regex" }),
        );
        expect(invalidInput).toMatchObject({
          ok: false,
          error: { _tag: "AnalysisInputError" },
        });
      }
      const stopped = new AbortController();
      const reason = { reason: "caller stopped" };
      stopped.abort(reason);
      const cancelled = await settings.run(() =>
        client.execute(
          "search_strings",
          { pattern: "main", mode: "regex" },
          { signal: stopped.signal },
        ),
      );
      if (cancelled.ok) throw new Error("Expected cancellation");
      expect(cancelled.error.cause).toBe(reason);
      expect(await fakeKunaCalls(kuna)).toEqual(before);
      expect(
        provider
          .capabilities()
          .find(({ operation }) => operation === "search_strings")
          ?.limitations.join(" "),
      ).toContain("unavailable");
      const literal = await settings.run(() =>
        client.execute("search_procedures", {
          pattern: "main",
          mode: "literal",
        }),
      );
      expect(literal.ok).toBe(true);
      for (const operation of ["list_strings", "list_procedures"] as const) {
        expect(
          (await settings.run(() => client.execute(operation, {}))).ok,
        ).toBe(true);
      }
      expect(
        settings.update({ changes: [{ setting, action: "set", value }] }).ok,
      ).toBe(true);
      const allowed = await settings.run(() =>
        client.execute("search_procedures", { pattern: "main", mode: "regex" }),
      );
      expect(allowed.ok).toBe(true);
      expect(
        settings.update({ changes: [{ setting, action: "reset" }] }).ok,
      ).toBe(true);
      const denied = await settings.run(() =>
        client.execute("search_procedures", { pattern: "main", mode: "regex" }),
      );
      expect(denied).toMatchObject({
        ok: false,
        error: { _tag: "ConfigurationError" },
      });
    } finally {
      const closed = await client.close();
      if (!closed.ok) throw closed.error;
      const cleaned = await provider.closeOwnedResources();
      if (!cleaned.ok) throw cleaned.error;
    }
  },
);
