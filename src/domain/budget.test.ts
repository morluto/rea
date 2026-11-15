import { describe, expect, it } from "vitest";
import { Budget } from "./budget.js";

describe("Budget", () => {
  const exhausted = () => new Error("exhausted");

  it("charges until the maximum and refuses without charging", () => {
    const budget = new Budget(10);
    budget.charge(6, exhausted);
    expect(budget.tryCharge(5)).toBe(false);
    expect(() => {
      budget.charge(5, exhausted);
    }).toThrow("exhausted");
    expect(budget.used).toBe(6);
    budget.charge(4, exhausted);
    expect(budget.remaining).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses a malformed charge %s without changing the remainder",
    (amount) => {
      const budget = new Budget(Number.MAX_SAFE_INTEGER);
      expect(budget.tryCharge(amount)).toBe(false);
      expect(budget.used).toBe(0);
    },
  );

  it("refunds without rising above the maximum", () => {
    const budget = new Budget(10);
    budget.charge(4, exhausted);
    budget.refund(3);
    expect(budget.used).toBe(1);
    budget.refund(5);
    expect(budget.remaining).toBe(10);
    expect(() => {
      budget.refund(-1);
    }).toThrow(/refund/u);
  });

  it("rejects a malformed maximum", () => {
    expect(() => new Budget(-1)).toThrow(/maximum/u);
  });
});
