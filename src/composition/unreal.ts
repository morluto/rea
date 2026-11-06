import { UnrealPakService } from "../application/unreal/UnrealPakService.js";
import { UnrealPakProvider } from "../unreal/UnrealPakProvider.js";

/** Compose bundled offline inspection without acquiring a toolchain or starting any process. */
export const createUnrealPakService = (): UnrealPakService =>
  new UnrealPakService(new UnrealPakProvider());
