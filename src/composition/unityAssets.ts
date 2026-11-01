import { UnityAssetsService } from "../application/unity/UnityAssetsService.js";
import { UnityAssetsProvider } from "../unity/UnityAssetsProvider.js";

/** Compose read-only SerializedFile inspection without Unity or file writes. */
export const createUnityAssetsService = (): UnityAssetsService =>
  new UnityAssetsService(new UnityAssetsProvider());
