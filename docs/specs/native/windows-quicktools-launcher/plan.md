# Windows quick tools launcher — plan

1. Launcher skeleton (`tools/windows/REA-QuickTools.bat`): UTF-8 menu,
   `setlocal`, env defaults only when the target directories exist.
2. Discovery of node.exe + the packaged rea.mjs entry; `.cmd` fallback
   rejected after review (CALL re-parses arguments).
3. Injection hardening: delayed-expansion-only access to analyst values,
   single `!REA_ARGS!` dispatch site, cleared menu variables, closed-stdin
   stop, `!`-location pre-flight.
4. Packaging: publish allowlist entries for the launcher and the Thai
   guide; guide registered in product documentation.
5. Behavior tests with a recording stub plus structure guards; runner lane
   `--windows-tools` with an executed-behavior assertion.
6. Review-driven corrections across four rounds (setlocal scope, stdin
   loop, injection surfaces, `%`/`!` expansion, selector routing, guide
   facts).
