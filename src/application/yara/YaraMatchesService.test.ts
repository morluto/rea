import { expect, it, vi } from "vitest";

import { ok } from "../../domain/result.js";
import type { YaraMatches } from "../../domain/yara/yaraMatches.js";
import type { YaraMatchesPort } from "../../ports/yara/YaraMatchesPort.js";
import { YaraMatchesService } from "./YaraMatchesService.js";

const SHA = "a".repeat(64);

const report = (path: string): YaraMatches => ({
  artifact: { path, sha256: SHA, bytes: 4 },
  rule_files: [{ path: "/rules/a.yar", sha256: SHA, bytes: 10 }],
  fast_scan: false,
  matches: [
    {
      rule: "A",
      tags: [],
      meta: [],
      string_match_count: 1,
      strings: [{ identifier: "$a", file_offset: 0, length: 1, data: "A" }],
    },
  ],
  coverage: {
    status: "complete",
    matched_rules: 1,
    string_matches: 1,
    listed_string_matches: 1,
  },
  limits: {
    max_matches: { value: 256, source: "default" },
    max_output_bytes: { value: 64 * 1024 * 1024, source: "default" },
    command_timeout_ms: { value: 60_000, source: "default" },
    max_file_bytes: 2 * 1024 * 1024 * 1024,
  },
  warnings: [],
  limitations: ["observed"],
});

const provider = (value: YaraMatches) => {
  const inspect = vi.fn<YaraMatchesPort["inspect"]>(async () => ok(value));
  const port: YaraMatchesPort = {
    identity: { id: "yara.command", name: "yara command", version: null },
    close: async () => {},
    inspect,
  };
  return { port, inspect };
};

const INPUT = { path: "/work/sample.bin", rule_paths: ["/rules/a.yar"] };

it("records only the caller's selections as Evidence parameters", async () => {
  const observed = report(INPUT.path);
  const { port, inspect } = provider({
    ...observed,
    limits: {
      ...observed.limits,
      max_matches: { value: 256, source: "runtime" },
    },
  });
  const service = new YaraMatchesService(port, {}, () => ({
    revision: 1,
    overrides: { "yara.max_matches": 256 },
  }));
  const result = await service.inspect(INPUT);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.parameters).toEqual(INPUT);
  expect(inspect.mock.calls[0]?.[0].settings.max_matches).toEqual({
    value: 256,
    source: "runtime",
  });
});

it("refuses a report whose path or limits differ from the request", async () => {
  const moved = new YaraMatchesService(
    provider(report("/work/other.bin")).port,
    {},
  );
  const result = await moved.inspect(INPUT);
  expect(!result.ok && result.error._tag).toBe("AnalysisOutputError");
  const seeded = new YaraMatchesService(provider(report(INPUT.path)).port, {
    REA_YARA_MAX_MATCHES: "5",
  });
  const limited = await seeded.inspect(INPUT);
  expect(!limited.ok && limited.error._tag).toBe("AnalysisOutputError");
});

it("refuses an invalid launch seed before calling the provider", async () => {
  const { port, inspect } = provider(report(INPUT.path));
  const service = new YaraMatchesService(port, {
    REA_YARA_COMMAND_TIMEOUT_MS: "soon",
  });
  const result = await service.inspect(INPUT);
  expect(!result.ok && result.error._tag).toBe("ConfigurationError");
  expect(inspect).not.toHaveBeenCalled();
});

it("returns cancellation without calling the provider", async () => {
  const { port, inspect } = provider(report(INPUT.path));
  const controller = new AbortController();
  controller.abort();
  const result = await new YaraMatchesService(port, {}).inspect(INPUT, {
    signal: controller.signal,
  });
  expect(!result.ok && result.error._tag).toBe("AnalysisCancelledError");
  expect(inspect).not.toHaveBeenCalled();
});
