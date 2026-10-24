import {
  createVerifierSourceOwner,
  importVerifierSource,
} from "./verifier-source-loader.mjs";

let implementation;

/** Load the development command owner and its canonical process source graph. */
export async function createVerifierCommands(options = {}) {
  return createVerifierSourceOwner(options, async (ownedOptions) => {
    implementation ??= importVerifierSource(
      new URL("./verifier-command-owner.mts", import.meta.url).href,
      import.meta.url,
    );
    const module = await implementation;
    return module.createVerifierCommands(ownedOptions);
  });
}
