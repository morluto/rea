# Dylib-use otool capture

`otool-dylib-use.txt` is the actual `otool -h -l` stdout retained by the
[Apple CLI/MCP verification job](https://github.com/morluto/rea/actions/runs/38176410166/job/114579755550).
Only its first filename line was replaced with `/owned/fixture:`.

The source-built application comes from `scripts/verify/apple/macos-bundle.mjs`.
Its 23 load commands include a delayed dependency on `@rpath/libdelay.dylib`.
That dylib-use command has an `options delay-init` row instead of the legacy
`time stamp` row. The other three dylib commands retain the legacy form.

The capture establishes actual producer text, command framing and dependency
fields. Linux replay tests do not establish real macOS provider execution;
the Apple CLI/MCP verification lane supplies that coverage.
