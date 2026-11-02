import { UnityAddressablesService } from "../application/unity/UnityAddressablesService.js";
import { UnityAddressablesProvider } from "../unity/UnityAddressablesProvider.js";

/** Compose bundled offline catalog inspection without acquiring a toolchain or starting any process. */
export const createUnityAddressablesService = (): UnityAddressablesService =>
  new UnityAddressablesService(new UnityAddressablesProvider());
