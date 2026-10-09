import { NonRegularFileReadError } from "../filesystem/RegularFile.js";
import { readRegularFile } from "./RegularFileRead.js";

/** The selected client configuration descriptor is not a regular file. */
export class ClientConfigurationNotRegularError extends TypeError {
  constructor(path: string) {
    super(`Client configuration must be a regular file: ${path}`);
  }
}

/** Read a client configuration without waiting for a FIFO writer. */
export const readClientConfigurationText = async (
  path: string,
): Promise<string> => {
  try {
    return (await readRegularFile(path)).toString("utf8");
  } catch (cause: unknown) {
    if (cause instanceof NonRegularFileReadError)
      throw new ClientConfigurationNotRegularError(path);
    throw cause;
  }
};
