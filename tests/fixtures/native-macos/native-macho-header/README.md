# Source-built Mach-O header capture

Captured on macOS arm64 with the host Xcode tools from the adjacent `fixture.c`:

```sh
xcrun clang fixture.c -o fixture
xcrun otool -l fixture > otool-load.txt
{ xcrun otool -h fixture; xcrun otool -l fixture; } > otool-header-load.txt
```

Only the temporary fixture path was replaced with `/owned/fixture`; tool fields
are unchanged. The first output contains load commands without a Mach header.
The second contains the real numeric header followed by those same commands.
These are format regression captures, not Hopper or Ghidra runtime proof.
