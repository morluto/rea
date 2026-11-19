export const HOST_ONLY_COMMANDS: ReadonlyMap<string, string>;
export const CLI_ONLY_FILES: ReadonlyMap<string, string>;
export function cliTextGuardSelects(path: string): boolean;
export function cliTextOutsideCliCount(content: string): number;
