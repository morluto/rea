import type { JsonValue } from "../../src/domain/jsonValue.js";

/** Successful bridge replies the fake Hopper serves. */
export function fakeHopperReply(method: string): JsonValue | undefined;

/** Every method fakeHopperReply answers. */
export const FAKE_HOPPER_REPLY_METHODS: readonly string[];
