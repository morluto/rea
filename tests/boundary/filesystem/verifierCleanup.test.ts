import { expect, it } from "vitest";
import {
  closeVerifierResources,
  releaseAfter,
} from "../../../scripts/lib/verifier-cleanup.mjs";

it("releases a root only after every dependent cleanup succeeds", async () => {
  const order: string[] = [];
  await closeVerifierResources([
    releaseAfter(
      [
        async () => {
          order.push("client");
        },
        async () => {
          order.push("transport");
        },
      ],
      async () => {
        order.push("root");
      },
      "/fixture/root",
    ),
  ]);
  expect(order).toEqual(["client", "transport", "root"]);
});

it("retains the root and reports every dependent failure", async () => {
  const order: string[] = [];
  const clientFailure = new Error("client close failed");
  const failure = await closeVerifierResources([
    releaseAfter(
      [
        async () => {
          order.push("client");
          throw clientFailure;
        },
        async () => {
          order.push("transport");
        },
      ],
      async () => {
        order.push("root");
      },
      "/fixture/root",
    ),
  ]).catch((cause: unknown) => cause);
  // The later dependent is still attempted, but the root is not released.
  expect(order).toEqual(["client", "transport"]);
  expect(failure).toBeInstanceOf(AggregateError);
  const [retention] = (failure as AggregateError).errors;
  expect(retention).toBeInstanceOf(AggregateError);
  expect((retention as AggregateError).errors).toEqual([
    clientFailure,
    new Error("Retained /fixture/root because a dependent cleanup failed."),
  ]);
});
