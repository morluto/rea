import { describe, expect, it } from "vitest";

import {
  isSwiftRuntimeLibrary,
  nativeRuntimeConvention,
} from "./nativeConvention.js";

describe("native runtime path conventions", () => {
  it("matches runtime families by filename or path segment", () => {
    expect(nativeRuntimeConvention("lib/arm64-v8a/libreactnativejni.so")).toBe(
      "react-native",
    );
    expect(
      nativeRuntimeConvention(
        "Payload/App.app/Frameworks/React.framework/React",
      ),
    ).toBe("react-native");
    expect(nativeRuntimeConvention("lib/arm64-v8a/libhermes.so")).toBe(
      "react-native",
    );
    expect(nativeRuntimeConvention("Frameworks/hermes.framework/hermes")).toBe(
      "react-native",
    );
    expect(nativeRuntimeConvention("lib/arm64-v8a/libflutter.so")).toBe(
      "flutter",
    );
    expect(
      nativeRuntimeConvention("Frameworks/Flutter.framework/Flutter"),
    ).toBe("flutter");
    expect(nativeRuntimeConvention("lib/arm64-v8a/libunity.so")).toBe("unity");
    expect(
      nativeRuntimeConvention(
        "Frameworks/UnityFramework.framework/UnityFramework",
      ),
    ).toBe("unity");
  });

  it("does not treat unrelated substrings as a runtime family", () => {
    expect(nativeRuntimeConvention("community")).toBeNull();
    expect(nativeRuntimeConvention("lib/arm64-v8a/libcommunity.so")).toBeNull();
    expect(
      nativeRuntimeConvention(
        "Payload/App.app/Frameworks/MyApp.framework/MyApp",
      ),
    ).toBeNull();
    expect(nativeRuntimeConvention("notes/react-readme.txt")).toBeNull();
    expect(nativeRuntimeConvention("assets/hermes/index.js")).toBeNull();
  });

  it("recognizes Swift runtime libraries without classifying every dylib", () => {
    expect(isSwiftRuntimeLibrary("SwiftSupport/libswiftCore.dylib")).toBe(true);
    expect(isSwiftRuntimeLibrary("Frameworks/libfoo.dylib")).toBe(false);
    expect(isSwiftRuntimeLibrary("Frameworks/libswift.dylib")).toBe(false);
  });
});
