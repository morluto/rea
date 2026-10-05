# Source-built re-export load command

Captured from the adjacent C sources using the macOS arm64 host Xcode tools:

```sh
xcrun clang -dynamiclib leaf.c -Wl,-install_name,@rpath/libLeaf.dylib -o libLeaf.dylib
xcrun clang -dynamiclib outer.c -Wl,-reexport_library,libLeaf.dylib -o libOuter.dylib
xcrun otool -l libOuter.dylib > otool-load.txt
```

The temporary outer-library path was replaced with `/owned/libOuter.dylib`.
The load-command fields are otherwise unmodified. The capture retains the real
re-export, ID, and ordinary libSystem dependency. It proves format parsing,
not Hopper or Ghidra behavior.
