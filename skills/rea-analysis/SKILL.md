---
name: rea-analysis
description: Reverse engineer apps with REA. Explore how features work, then build a version tailored to your project.
---

# REA

Use REA when the user wants to understand how an app or feature works, compare app versions, decompile code, or build a similar feature.

## Understand the request

Identify the app and what the user wants to understand or build. Do not ask for information they already provided.

If the app is missing, ask which app they want to reverse engineer. If the app is known but the goal is unclear, ask what they want to understand or build, and offer to start with an overview. Never require the user to supply a program path, address, architecture, or reverse-engineering terminology.

Notes is only a documentation example. Never select an app unless the user names it or confirms it.

## Ensure REA is ready

1. Run `npx -y @morluto/rea doctor`.
2. If setup is needed, explain that REA may install Homebrew and Hopper. Hopper is separate software and requires its own license.
3. Obtain approval before installing external software, then run `npx -y @morluto/rea setup --yes`.
4. If macOS or an installer requests human input, tell the user exactly what needs attention. After they finish, rerun setup and doctor.
5. If setup registers a new MCP server, tell the user to restart their coding agent to load all REA tools. Direct CLI commands remain available before restart.

## Locate the app

Accept a human-readable app name. Search macOS application locations and system metadata. If one clear match is found, continue without asking for a path. If several apps match, show their names and locations and ask which one the user means. If none match, ask where the app is installed.

REA accepts a `.app` bundle directly. Do not expose its internal `Contents/MacOS` path unless it helps explain an error.

## Investigate

Briefly tell the user what you will investigate. Open the app with `open_binary`, begin with `binary_overview`, and narrow the investigation around the requested feature. Use decompilation, strings, names, callers, callees, and cross-references as needed.

Explain conclusions in plain language. Point to the relevant decompiled code, strings, names, and connections so the user can see how the explanation was reached. Do not claim to recover original source code or automatically clone an application.

## Build

When requested, use normal coding tools to build a version suited to the user's project, stack, interface, and requirements. Keep the implementation tied to what the investigation established, and distinguish observed behavior from assumptions or design choices.

## Human input and cleanup

Hopper or macOS may show a window that needs human input. Tell the user what appeared and ask them to handle it; do not guess or take over unrelated UI. Call `close_binary` when the investigation is complete.
