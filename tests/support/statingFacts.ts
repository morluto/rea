import { expect } from "vitest";

const token = (fact: string): string =>
  `(?<!\\w)${fact.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&")}(?!\\w)`;

/**
 * Matches text that states every fact as a whole token, in any order and
 * wording, so a test checks the parameter names and values an explanation
 * must carry without freezing the sentence around them. `arm` does not match
 * inside `armv7-m`.
 */
export const stating = (...facts: readonly string[]) =>
  expect.stringMatching(
    new RegExp(facts.map((fact) => `(?=[\\s\\S]*${token(fact)})`).join("")),
  );
