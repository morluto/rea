import type { WebPageInspection } from "../domain/browserObservation.js";

export interface CapturedScript {
  readonly scriptId: string;
  readonly rawUrl: string;
  readonly url: string;
  readonly origin: string | null;
  readonly hash: string;
  readonly length: number;
  readonly isModule: boolean;
  readonly language: string | null;
  readonly sourceMapUrl: string | null;
  readonly sourceMapRawUrl: string | null;
  readonly executionContextKey: string | null;
}

export type NetworkState = WebPageInspection["network"]["requests"][number];
