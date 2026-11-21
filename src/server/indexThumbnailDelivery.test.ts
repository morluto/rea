import { expect, it } from "vitest";
import { appendIndexThumbnailContent } from "./indexThumbnailDelivery.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";
import { measureMcpResultWithinBudget } from "./toolResultEncoding.js";
it("delivers image blocks when the complete duplicated representation fits", () => {
  const result = {
    content: [{ type: "text" as const, text: "result" }],
    structuredContent: { ok: true },
  };
  const output = appendIndexThumbnailContent(
    result,
    [{ type: "image", mimeType: "image/png", data: "AA==" }],
    new ToolResultDelivery(8192),
  );
  expect(output.isError).not.toBe(true);
  expect(output.content.some((c) => c.type === "image")).toBe(true);
});
it("retains the successful Evidence response when optional images exceed the budget", () => {
  const delivery = new ToolResultDelivery(8192);
  const result = {
    content: [{ type: "text" as const, text: "x".repeat(3000) }],
    structuredContent: { data: "x".repeat(3000) },
  };
  expect(
    measureMcpResultWithinBudget(result, delivery.resultBudgetBytes).ok,
  ).toBe(true);
  const output = appendIndexThumbnailContent(
    result,
    [{ type: "image", mimeType: "image/png", data: "A".repeat(4000) }],
    delivery,
  );
  expect(output).toBe(result);
  expect(output.isError).not.toBe(true);
  expect(output.structuredContent).toBe(result.structuredContent);
  expect(
    measureMcpResultWithinBudget(output, delivery.resultBudgetBytes).ok,
  ).toBe(true);
});
it("does not add images after an existing error", () => {
  const result = {
    isError: true,
    content: [{ type: "text" as const, text: "refused" }],
  };
  expect(
    appendIndexThumbnailContent(
      result,
      [{ type: "image", mimeType: "image/png", data: "AA==" }],
      new ToolResultDelivery(8192),
    ),
  ).toBe(result);
});
