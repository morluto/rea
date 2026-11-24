import { expect, it } from "vitest";

import {
  completeEvidenceArguments,
  completeEvidenceCliArguments,
} from "../../support/completeEvidenceByDefault.js";

it("requests complete Evidence only for budgeted tools that select neither detail nor view", () => {
  expect(
    completeEvidenceArguments("inspect_managed_members", { path: "/a" }),
  ).toEqual({
    path: "/a",
    detail: "complete",
  });
  expect(completeEvidenceArguments("inspect_artifact", undefined)).toEqual({
    detail: "complete",
  });
  for (const selected of [
    { path: "/a", detail: "summary" },
    { path: "/a", detail: "complete" },
    { path: "/a", view: { kind: "summary" } },
  ])
    expect(completeEvidenceArguments("inspect_managed_members", selected)).toBe(
      selected,
    );
  // A tool whose omitted detail is not budgeted, and a forwarded upstream
  // tool, are sent as written.
  const desktop = { path: "/apps/game" };
  expect(
    completeEvidenceArguments("inspect_desktop_application", desktop),
  ).toBe(desktop);
  const forwarded = { x: 1 };
  expect(completeEvidenceArguments("computer_click", forwarded)).toBe(
    forwarded,
  );
});

it("adds --detail complete to budgeted CLI commands under the same rule", () => {
  expect(
    completeEvidenceCliArguments(["inspect-byte-entropy", "/f", "--json"]),
  ).toEqual(["inspect-byte-entropy", "--detail", "complete", "/f", "--json"]);
  for (const argv of [
    ["inspect-byte-entropy", "/f", "--detail", "summary", "--json"],
    ["inspect-byte-entropy", "/f", "--detail=summary"],
    ["inspect-rust-binary", "/f", "--view", "{}"],
    ["inspect-binary-layout", "/f", "--json"],
    ["doctor"],
  ])
    expect(completeEvidenceCliArguments(argv)).toBe(argv);
});
