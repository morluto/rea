import { expect, it } from "vitest";
import {
  BOUNDED_PRODUCER_LIMITS,
  clampLinuxResourceLimits,
  prlimitArgumentVector,
} from "./LinuxResourceLimits.js";
const configured = {
  address_space_bytes: 1073741824,
  file_bytes: 67108864,
  cpu_seconds: 30,
};
const report = (
  memory: string,
  file = "unlimited unlimited",
  cpu = "unlimited unlimited",
) =>
  `Limit Soft Limit Hard Limit Units\nMax address space ${memory} bytes\nMax file size ${file} bytes\nMax cpu time ${cpu} seconds\n`;
it("keeps configured ceilings below unlimited or larger inherited limits", () => {
  expect(
    clampLinuxResourceLimits(configured, report("unlimited unlimited")),
  ).toEqual(configured);
  expect(
    clampLinuxResourceLimits(
      configured,
      report("18446744073709551615 18446744073709551615"),
    ),
  ).toEqual(configured);
});
it("preserves stricter soft limits and lower hard ceilings, including zero", () => {
  expect(
    clampLinuxResourceLimits(
      configured,
      report("268435456 2147483648", "0 1048576", "10 20"),
    ),
  ).toEqual({ address_space_bytes: 268435456, file_bytes: 0, cpu_seconds: 10 });
  expect(
    clampLinuxResourceLimits(configured, report("268435456 536870912")),
  ).toMatchObject({ address_space_bytes: 268435456 });
});
it("refuses missing, ambiguous or malformed kernel limits before launch", () => {
  for (const value of [
    "",
    report("invalid unlimited"),
    report("unlimited unlimited") + "Max address space 1 2 bytes\n",
  ])
    expect(() => clampLinuxResourceLimits(configured, value)).toThrow();
});
it("pins the shared producer budget in one place", () => {
  expect(BOUNDED_PRODUCER_LIMITS).toEqual({
    input_bytes: 33554432,
    output_bytes: 4194304,
    command_timeout_ms: 30000,
    address_space_bytes: 1073741824,
    file_bytes: 67108864,
    cpu_seconds: 30,
  });
});
it("pairs each effective ceiling with itself before the producer argv", () => {
  expect(
    prlimitArgumentVector(BOUNDED_PRODUCER_LIMITS, "/bin/producer"),
  ).toEqual([
    "--as=1073741824:1073741824",
    "--fsize=67108864:67108864",
    "--cpu=30:30",
    "--core=0:0",
    "--",
    "/bin/producer",
  ]);
  expect(
    prlimitArgumentVector(
      clampLinuxResourceLimits(BOUNDED_PRODUCER_LIMITS, report("10 20")),
      "/bin/producer",
    ),
  ).toEqual([
    "--as=10:10",
    "--fsize=67108864:67108864",
    "--cpu=30:30",
    "--core=0:0",
    "--",
    "/bin/producer",
  ]);
});
