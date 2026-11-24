import { expect, it } from "vitest";
import { browserScenarioSchema } from "../../../src/domain/browserScenario.js";
import { browserScenarioReferences } from "../../fixtures/browserScenarioReferences.js";

it.each(["query", "storage", "session-storage", "cookie"] as const)(
  "preserves a declared %s reference list wider than call arguments",
  (placement) => {
    // Forked tests share the CLI/MCP main-thread stack, unlike domain threads.
    const count = 130_000;
    const parsed = browserScenarioSchema.parse(
      browserScenarioReferences(placement, count),
    );
    const entries =
      placement === "query"
        ? parsed.start_url.query
        : placement === "cookie"
          ? parsed.storage.cookies[0]?.destination.query
          : parsed.storage[
              placement === "session-storage"
                ? "session_storage"
                : "local_storage"
            ][0]?.entries;
    expect(entries).toHaveLength(count);
    expect(entries?.[0]).toEqual({
      name: "entry_0",
      value: { source: "secret", secret_id: "token" },
    });
    expect(entries?.at(-1)).toEqual({
      name: `entry_${String(count - 1)}`,
      value: { source: "secret", secret_id: "token" },
    });
  },
);

it("reports each distinct undeclared identity once across query, cookie, and storage uses", () => {
  const input = browserScenarioReferences("query", 3);
  input.secrets = [];
  const entry = (secret_id: string) => ({
    name: secret_id,
    value: { source: "secret", secret_id },
  });
  const origin = "http://127.0.0.1:1";
  input.storage.local_storage = [
    { origin, entries: [entry("local"), entry("token")] },
  ];
  input.storage.session_storage = [{ origin, entries: [entry("session")] }];
  input.storage.cookies = browserScenarioReferences(
    "cookie",
    1,
  ).storage.cookies;
  input.storage.cookies[0]!.destination.query = [entry("cookie")];
  const { error } = browserScenarioSchema.safeParse(input);
  expect(error?.issues.map(({ path, message }) => ({ path, message }))).toEqual(
    ["token", "cookie", "local", "session"].map((id) => ({
      path: ["secrets"],
      message: `Secret reference ${id} is not declared`,
    })),
  );
});
