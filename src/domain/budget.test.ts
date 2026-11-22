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

  it("records an over-committing charge and refuses ordinary charges until refunded", () => {
    const budget = new Budget(10);
    expect(budget.chargeOverCommitting(6)).toBe(0);
    expect(budget.chargeOverCommitting(7)).toBe(3);
    expect(budget.used).toBe(13);
    expect(budget.overCommitted).toBe(3);
    expect(budget.remaining).toBe(0);
    expect(budget.tryCharge(0)).toBe(true);
    expect(budget.tryCharge(1)).toBe(false);
    budget.refund(5);
    expect(budget.overCommitted).toBe(0);
    expect(budget.remaining).toBe(2);
    expect(() => budget.chargeOverCommitting(1.5)).toThrow(/charge/u);
    expect(budget.used).toBe(8);
  });

  it("evicts the oldest entries until a charge fits", () => {
    const budget = new Budget(10);
    const entries = [4, 3, 2];
    for (const size of entries) budget.charge(size, exhausted);
    const evict = () => {
      const oldest = entries.shift();
      return oldest;
    };
    expect(budget.chargeEvicting(6, evict)).toBe(true);
    // 9 used: evicting 4 frees 5, still short of 6; evicting 3 makes room.
    expect(entries).toEqual([2]);
    expect(budget.used).toBe(8);
    // Larger than the maximum: nothing is evicted.
    expect(budget.chargeEvicting(11, evict)).toBe(false);
    expect(entries).toEqual([2]);
    expect(budget.used).toBe(8);
  });

  it("refuses an evicting charge when nothing is left to evict", () => {
    const budget = new Budget(10);
    budget.charge(8, exhausted);
    expect(budget.chargeEvicting(5, () => undefined)).toBe(false);
    expect(budget.used).toBe(8);
  });

  it("restores a checkpoint by refunding, never by re-charging", () => {
    const budget = new Budget(10);
    budget.charge(3, exhausted);
    const mark = budget.used;
    budget.charge(5, exhausted);
    expect(budget.restore(mark)).toBe(5);
    expect(budget.used).toBe(3);
    budget.refund(3);
    expect(budget.restore(mark)).toBe(0);
    expect(budget.used).toBe(0);
  });

  it("rejects a malformed maximum", () => {
    expect(() => new Budget(-1)).toThrow(/maximum/u);
  });
});
