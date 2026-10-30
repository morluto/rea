import type { XtensaElfMetadata } from "../../../src/domain/binaryTargetTypes.js";

export const XTENSA_LANGUAGE: "Xtensa:LE:32:default";
export const XTENSA_COMPILER_SPEC: "default";
export interface XtensaReadelfFacts {
  xtensa: XtensaElfMetadata;
  symbols: Record<string, string>;
  descriptor: string;
}
export function parseXtensaReadelf(
  text: string,
  names: readonly string[],
): XtensaReadelfFacts;
export function inspectXtensaReadelf(
  path: string,
  names: readonly string[],
): Promise<XtensaReadelfFacts & { command: string; version: string }>;
export function assertXtensaFixtureInstructions(
  instructions: Record<"entry" | "l32r" | "call8" | "retw", unknown>,
  addresses: { leaf: string; literal: string },
): void;
export function assertXtensaFixturePseudocode(
  entry: string,
  leaf: string,
  values: { literal: number; addend: number },
): void;
export function assertXtensaCFixturePseudocode(
  entry: string,
  scale: string,
  values: { global: string; factor: number; constant: number },
): void;
