import { defineConfig } from "vitepress";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  documentationRewrites,
  documentationSections,
} from "./documentation.js";

const documentationRoot = fileURLToPath(new URL("..", import.meta.url));
const rewrites: Record<string, string> = {
  ...documentationRewrites,
  "README.md": "documentation.md",
  "specs/README.md": "specs/index.md",
  "adr/README.md": "adr/index.md",
};

export default defineConfig({
  title: "REA",
  description:
    "Reverse engineer binaries, applications, and runtime behavior with one CLI and MCP server.",
  lang: "en-US",
  base: "/rea/",
  rewrites,
  markdown: {
    config(md) {
      // Repository links resolve from their physical source. Render them from
      // the stable public route instead, including links across categories.
      md.core.ruler.after("inline", "documentation-source-links", (state) => {
        const physicalPath =
          state.env.realPath ??
          (state.env.relativePath
            ? resolve(documentationRoot, state.env.relativePath)
            : null);
        if (physicalPath === null) return;
        const renderedPath =
          state.env.path ??
          resolve(
            documentationRoot,
            rewrites[state.env.relativePath] ?? state.env.relativePath,
          );
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            const attribute =
              token.type === "link_open"
                ? "href"
                : token.type === "image"
                  ? "src"
                  : null;
            if (attribute === null) continue;
            const destination = token.attrGet(attribute);
            if (
              !destination ||
              /^(?:[a-z][a-z\d+.-]*:|[/#])/iu.test(destination)
            )
              continue;
            const separator = destination.search(/[?#]/u);
            const path =
              separator === -1 ? destination : destination.slice(0, separator);
            const suffix = separator === -1 ? "" : destination.slice(separator);
            const source = relative(
              documentationRoot,
              resolve(dirname(physicalPath), path),
            )
              .split(sep)
              .join("/");
            const rendered = relative(
              dirname(renderedPath),
              resolve(
                documentationRoot,
                source.startsWith("public/")
                  ? source.slice("public/".length)
                  : (rewrites[source] ?? source),
              ),
            )
              .split(sep)
              .join("/");
            token.attrSet(attribute, rendered + suffix);
          }
        }
      });
    },
  },
  srcExclude: ["readme/**"],
  themeConfig: {
    nav: [
      { text: "Get started", link: "/installation" },
      { text: "Documentation", link: "/documentation" },
      { text: "Reference", link: "/mcp-contracts" },
      { text: "Roadmap", link: "/roadmap" },
    ],
    sidebar: [
      {
        text: "Documentation directory",
        items: [
          { text: "All guides", link: "/documentation" },
          { text: "Authoring conventions", link: "/development/documentation" },
          { text: "Feature specifications", link: "/specs/" },
          { text: "Architecture decisions", link: "/adr/" },
        ],
      },
      ...documentationSections.map((section) => ({
        text: section.text,
        collapsed: section.text !== "Getting started",
        items: section.items.map((item) => ({
          text: item.text,
          link: item.route,
        })),
      })),
    ],
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/morluto/rea" },
      { icon: "discord", link: "https://discord.gg/GkcryMnJDM" },
    ],
    editLink: {
      pattern: "https://github.com/morluto/rea/edit/main/docs/:path",
    },
    footer: {
      message: "Released under the MIT License.",
    },
  },
});
