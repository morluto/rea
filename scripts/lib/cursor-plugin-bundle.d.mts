export const CURSOR_PLUGIN_MANIFEST: ".cursor-plugin/plugin.json";
export const CURSOR_PLUGIN_MCP: "mcp.json";
export const AUTHORED_SKILL_DIRECTORY: ".agents/skills/reverse-engineer-anything";
export const CURSOR_PLUGIN_SKILLS: ".cursor-plugin/skills";
export const CURSOR_PLUGIN_SKILL: "reverse-engineer-anything";
export const CURSOR_PLUGIN_LOGO: "assets/rea-plugin.png";
export const CURSOR_PLUGIN_REPOSITORY: "https://github.com/morluto/rea";

export interface CursorPluginBundleIssue {
  readonly field: string;
}

export interface CursorPluginBundleInput {
  readonly manifest: {
    readonly name?: string;
    readonly version?: string;
    readonly description?: string;
    readonly author?: { readonly name?: string };
    readonly repository?: string;
    readonly license?: string;
    readonly keywords?: readonly string[];
    readonly skills?: string;
    readonly logo?: string;
    readonly mcpServers?: unknown;
  };
  readonly mcp: {
    readonly mcpServers?: {
      readonly rea?: {
        readonly command?: string;
        readonly args?: readonly string[];
      };
    };
  };
  readonly packageVersion: string;
  readonly logoExists: boolean;
  readonly skillNames: readonly string[];
  readonly skillFrontmatter: {
    readonly name?: string;
    readonly description?: string;
  } | null;
}

export interface CursorPluginInspection {
  readonly manifest: CursorPluginBundleInput["manifest"] & {
    readonly version: string;
  };
  readonly mcp: {
    readonly mcpServers: {
      readonly rea: {
        readonly command: string;
        readonly args: readonly string[];
      };
    };
  };
  readonly packageVersion: string;
  readonly issues: readonly CursorPluginBundleIssue[];
}

export function cursorPluginSkillPaths(
  directory: string,
  prefix?: string,
): Promise<readonly string[] | null>;

export function cursorPluginBundleIssues(
  input: CursorPluginBundleInput,
): readonly CursorPluginBundleIssue[];

export function syncCursorPluginSkill(options: {
  readonly root: string;
  readonly check: boolean;
}): Promise<void>;

export function inspectCursorPluginBundle(
  root: string,
): Promise<CursorPluginInspection>;

export function cursorMarketplaceInstallLinkIssues(
  documents: readonly { readonly path: string; readonly text: string }[],
): readonly { readonly path: string; readonly marker: string }[];
