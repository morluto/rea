import { expect, it } from "vitest";
import { selectEvmWorkerLimits } from "./EvmWorkerLimits.js";

const limits = (
  soft = "unlimited",
  hard = "unlimited",
) => `Limit Soft Limit Hard Limit Units
Max address space ${soft} ${hard} bytes
Max cpu time unlimited unlimited seconds
Max file size unlimited unlimited bytes
`;
it("uses configured maxima without equating virtual space and RSS", () => {
  expect(selectEvmWorkerLimits(limits())).toEqual({
    ok: true,
    value: {
      addressSpaceBytes: 3221225472,
      cpuSeconds: 30,
      fileSizeBytes: 16777216,
    },
  });
});
it.each([
  ["1073741824", "2147483648", 1073741824],
  ["2147483648", "2147483648", 2147483648],
  ["0", "0", 0],
  ["9223372036854775807", "9223372036854775807", 3221225472],
])(
  "preserves tighter soft/hard boundaries without integer loss: %s/%s",
  (soft, hard, expected) => {
    expect(selectEvmWorkerLimits(limits(soft, hard))).toMatchObject({
      ok: true,
      value: { addressSpaceBytes: expected },
    });
  },
);
it("independently preserves CPU and file output restrictions", () => {
  expect(
    selectEvmWorkerLimits(
      limits()
        .replace("time unlimited unlimited", "time 5 10")
        .replace("size unlimited unlimited", "size 4096 8192"),
    ),
  ).toMatchObject({ ok: true, value: { cpuSeconds: 5, fileSizeBytes: 4096 } });
});
it.each([
  ["not-text", null],
  ["soft-unlimited-hard-finite", limits("unlimited", "2147483648")],
  ["soft-exceeds-hard", limits("3", "2")],
  ["missing-row", limits().replace("Max file size", "Max other size")],
  ["duplicate-row", limits() + "Max cpu time 1 1 seconds\n"],
  ["wrong-unit", limits().replace("bytes", "pages")],
  ["oversized", "x".repeat(65537)],
])("rejects malformed/ambiguous resource observations: %s", (_label, input) => {
  expect(selectEvmWorkerLimits(input).ok).toBe(false);
});
