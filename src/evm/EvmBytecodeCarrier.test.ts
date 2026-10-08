import { expect, it } from "vitest";
import {
  decodeEvmBytecodeCarrier,
  EvmCarrierFailure,
} from "./EvmBytecodeCarrier.js";

it.each(["6000FF", "0x6000ff", " \t0X6000FF\r\n"])(
  "decodes explicit hex without changing selected bytes: %j",
  (text) => {
    expect(
      Buffer.from(decodeEvmBytecodeCarrier(Buffer.from(text), "hex")).toString(
        "hex",
      ),
    ).toBe("6000ff");
  },
);
it.each(["0x1", "60 00", "0xzz", "\uFEFF6000", "\u00a06000"])(
  "rejects malformed carrier rather than guessing bytecode: %j",
  (text) => {
    expect(() => decodeEvmBytecodeCarrier(Buffer.from(text), "hex")).toThrow(
      EvmCarrierFailure,
    );
  },
);
it("distinguishes raw bytes, empty code and malformed UTF-8", () => {
  const bytes = Uint8Array.from([0xff, 0x00]);
  const decoded = decodeEvmBytecodeCarrier(bytes, "raw");
  expect(decoded).toEqual(bytes);
  expect(decoded).not.toBe(bytes);
  expect(() => decodeEvmBytecodeCarrier(bytes, "hex")).toThrow("valid UTF-8");
  expect(decodeEvmBytecodeCarrier(Buffer.from("0x"), "hex")).toEqual(
    new Uint8Array(),
  );
});
