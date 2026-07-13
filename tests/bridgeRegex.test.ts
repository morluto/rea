import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const bridgePath = fileURLToPath(
  new URL("../bridge/hopper_bridge.py", import.meta.url),
);
const probePath = fileURLToPath(
  new URL("./fixtures/bridgeRegexProbe.py", import.meta.url),
);

const errorResultSchema = z.object({
  action: z.enum(["match", "search"]),
  ok: z.literal(false),
  type: z.string(),
  diagnostic_type: z.string(),
  message: z.string(),
});
const matchResultSchema = z.object({
  action: z.literal("match"),
  ok: z.literal(true),
  backtracking_paths: z.number().int().positive(),
  matched: z.boolean(),
});
const searchResultSchema = z.object({
  action: z.literal("search"),
  ok: z.literal(true),
  result: z.object({
    items: z.array(
      z.object({
        address: z.string(),
        value: z.string(),
        value_truncated: z.boolean(),
      }),
    ),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    next_offset: z.number().int().nonnegative().nullable(),
    has_more: z.boolean(),
  }),
});
const probeResultSchema = z.union([
  errorResultSchema,
  matchResultSchema,
  searchResultSchema,
]);

type ProbeInput =
  | {
      readonly action: "match";
      readonly pattern: string;
      readonly value: string;
      readonly case_sensitive?: boolean;
    }
  | {
      readonly action: "search";
      readonly items: readonly (readonly [string, string])[];
      readonly params: Readonly<Record<string, string | number | boolean>>;
    };

const probe = async (input: ProbeInput) => {
  const result = await execFileAsync(
    "python3",
    [probePath, bridgePath, JSON.stringify(input)],
    { timeout: 3_000, maxBuffer: 1024 * 1024 },
  );
  return probeResultSchema.parse(JSON.parse(result.stdout));
};

const invalidRequest = (action: "match" | "search", message: string) => ({
  action,
  ok: false,
  type: "ValueError",
  diagnostic_type: "invalid_request",
  message,
});

describe("Hopper bridge regex bounds", () => {
  it("accepts useful patterns whose static backtracking budget is bounded", async () => {
    await expect(
      probe({
        action: "match",
        pattern: String.raw`^rea_(?:main|helper)_[0-9]{1,3}$`,
        value: "REA_helper_42",
      }),
    ).resolves.toEqual({
      action: "match",
      ok: true,
      backtracking_paths: 6,
      matched: true,
    });
  });

  it("applies bounded regex matching through deterministic pagination", async () => {
    await expect(
      probe({
        action: "search",
        items: [
          ["0x1000", "REA_main_1"],
          ["0x2000", "unrelated"],
          ["0x3000", "rea_helper_42"],
        ],
        params: {
          pattern: String.raw`^rea_(?:main|helper)_[0-9]{1,3}$`,
          mode: "regex",
          case_sensitive: false,
          offset: 1,
          limit: 1,
        },
      }),
    ).resolves.toEqual({
      action: "search",
      ok: true,
      result: {
        items: [
          {
            address: "0x3000",
            value: "rea_helper_42",
            value_truncated: false,
          },
        ],
        offset: 1,
        limit: 1,
        total: 2,
        next_offset: null,
        has_more: false,
      },
    });
  });

  it.each([
    [
      "lookaround",
      "(?=a)a",
      "Regex lookarounds and backreferences are not supported",
    ],
    [
      "backreference",
      String.raw`(a)\1`,
      "Regex lookarounds and backreferences are not supported",
    ],
    [
      "nested repeat",
      "(a{1,2}){1,2}",
      "Nested regex repetitions are not supported",
    ],
    [
      "unbounded repeat",
      "a+",
      "Unbounded or excessive regex repetitions are not supported",
    ],
    [
      "excessive repeat",
      "a{1001}",
      "Unbounded or excessive regex repetitions are not supported",
    ],
  ])("rejects unsupported %s constructs", async (_name, pattern, message) => {
    await expect(
      probe({ action: "match", pattern, value: "aaaa", case_sensitive: true }),
    ).resolves.toEqual(invalidRequest("match", message));
  });

  it.each(["(", "a{999999999999999999999999}"])(
    "normalizes parser failure %s through the search boundary",
    async (pattern) => {
      await expect(
        probe({
          action: "search",
          items: [],
          params: { pattern, mode: "regex", offset: 0, limit: 1 },
        }),
      ).resolves.toEqual(invalidRequest("search", "Invalid regex pattern"));
    },
  );

  it("accepts the maximum bounded repeat at the exact work budget", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "a{1000}",
        value: "a".repeat(1_000),
        case_sensitive: true,
      }),
    ).resolves.toEqual({
      action: "match",
      ok: true,
      backtracking_paths: 1,
      matched: true,
    });
  });

  it("accepts expensive matching just below the cumulative work limit", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "(?:a|aa){1,8}b",
        value: "a".repeat(115),
        case_sensitive: true,
      }),
    ).resolves.toEqual({
      action: "match",
      ok: true,
      backtracking_paths: 510,
      matched: false,
    });
  });

  it("rejects ambiguous bounded repetition before Python regex execution", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "(a|aa){1,35}b",
        value: "a".repeat(35),
        case_sensitive: true,
      }),
    ).resolves.toEqual(
      invalidRequest(
        "match",
        "Regex exceeds the 10000-path backtracking budget",
      ),
    );
  });

  it("rejects excessive combinations across adjacent optional atoms", async () => {
    await expect(
      probe({
        action: "match",
        pattern: `${"a?".repeat(14)}b`,
        value: "a".repeat(14),
        case_sensitive: true,
      }),
    ).resolves.toEqual(
      invalidRequest(
        "match",
        "Regex exceeds the 10000-path backtracking budget",
      ),
    );
  });

  it("bounds cumulative work before evaluating a costly candidate", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "(?:a|aa){1,12}b",
        value: "a".repeat(4_096),
        case_sensitive: true,
      }),
    ).resolves.toEqual(
      invalidRequest(
        "match",
        "Regex search exceeds the 1000000-unit work budget",
      ),
    );
  });

  it("applies the regex work budget across the full inventory", async () => {
    await expect(
      probe({
        action: "search",
        items: [
          ["0x1000", "a".repeat(60)],
          ["0x2000", "a".repeat(60)],
        ],
        params: {
          pattern: "(?:a|aa){1,8}b",
          mode: "regex",
          case_sensitive: true,
          offset: 0,
          limit: 1,
        },
      }),
    ).resolves.toEqual(
      invalidRequest(
        "search",
        "Regex search exceeds the 1000000-unit work budget",
      ),
    );
  });

  it("rejects oversized regex candidates instead of matching a prefix", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "needle",
        value: `${"x".repeat(4_096)}needle`,
      }),
    ).resolves.toEqual(
      invalidRequest(
        "match",
        "Regex candidate exceeds the 4096-character safety limit",
      ),
    );
  });

  it("accepts a regex candidate at the exact character limit", async () => {
    await expect(
      probe({
        action: "match",
        pattern: "z$",
        value: `${"a".repeat(4_095)}z`,
        case_sensitive: true,
      }),
    ).resolves.toEqual({
      action: "match",
      ok: true,
      backtracking_paths: 1,
      matched: true,
    });
  });

  it.each([
    [256, true],
    [257, false],
  ])("enforces the %i-character pattern boundary", async (length, accepted) => {
    const pattern = "a".repeat(length);
    const result = await probe({
      action: "search",
      items: [["0x1000", pattern]],
      params: {
        pattern,
        mode: "regex",
        case_sensitive: true,
        offset: 0,
        limit: 1,
      },
    });
    if (accepted) {
      expect(result).toMatchObject({
        action: "search",
        ok: true,
        result: { total: 1 },
      });
      return;
    }
    expect(result).toEqual(
      invalidRequest(
        "search",
        "pattern must contain between 1 and 256 characters",
      ),
    );
  });

  it("keeps literal matching exhaustive while bounding returned text", async () => {
    const result = await probe({
      action: "search",
      items: [["0x1000", `${"x".repeat(4_096)}needle`]],
      params: {
        pattern: "needle",
        mode: "literal",
        case_sensitive: true,
        offset: 0,
        limit: 1,
      },
    });
    expect(result).toMatchObject({
      action: "search",
      ok: true,
      result: {
        total: 1,
        has_more: false,
        items: [{ address: "0x1000", value_truncated: true }],
      },
    });
    if (result.action === "search" && result.ok)
      expect(result.result.items[0]?.value).toHaveLength(4_096);
  });
});
