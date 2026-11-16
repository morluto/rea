import type { JsonValue } from "../../src/domain/jsonValue.js";

/** Successful bridge replies the fake Hopper serves, keyed by method. */
export const FAKE_HOPPER_REPLIES: Readonly<
  Record<string, (params?: Readonly<Record<string, JsonValue>>) => JsonValue>
>;
export function fakeHopperReply(
  method: string,
  params?: Readonly<Record<string, JsonValue>>,
): JsonValue | undefined;

/** Every method fakeHopperReply answers. */
export const FAKE_HOPPER_REPLY_METHODS: readonly string[];
