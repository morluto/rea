# Captured Apple format fixtures

These are actual tool outputs, not records assembled to match the parser.
`provenance.json` records the capture host, producer versions, source digests
and immutable capture/expectation digests. Compiled binaries and catalogs are
not committed.

## Foundation archive

`keyed-archive/foundation.xml` is the XML representation of a binary archive
written by Foundation `NSKeyedArchiver`, using the source-owned Swift fixture.
`plutil` represents binary UID entries as `CF$UID` dictionaries. The captured
archive has six objects: nil, the root NSArray, one shared custom record,
its four-byte data payload and two class descriptors.

`keyed-archive/graph.json` is the reviewed complete expected graph. The source
establishes two references from the array to object 2, object 2's self-cycle,
its nil conditional reference and the payload `00 01 02 ff`. The reader reports
serialized classes as unknown and does not instantiate them. The synthetic
malformed-reference tests remain separate.

To recapture the input on an approved macOS host:

```sh
capture_root=$(mktemp -d)
xcrun swift -module-cache-path "$capture_root/modules" \
  tests/conformance/native/keyed-archive.swift "$capture_root/model.plist"
plutil -convert xml1 -o tests/fixtures/golden/keyed-archive/foundation.xml \
  "$capture_root/model.plist"
rm -rf "$capture_root"
```

Review expected graph changes against the source and XML before updating the
expectation or provenance. Tests never rewrite the golden.

## Asset catalog

`assetutil.json` is the unmodified output of `/usr/bin/assetutil --info` for an
actual `actool` catalog. The source colorset defines `FixtureColor` with sRGB
components `[0.125, 0.5, 0.875, 1]`. Preserve private fields and producer metadata
in this fixed input, including its original timestamp; the test checks that the
projection does not discard them.

```sh
capture_root=$(mktemp -d)
xcrun actool tests/conformance/native/Assets.xcassets \
  --compile "$capture_root" --platform macosx --minimum-deployment-target 12.0
/usr/bin/assetutil --info "$capture_root/Assets.car" \
  > tests/fixtures/golden/assetutil.json
rm -rf "$capture_root"
```

The real E2E lane builds fresh catalogs and compares all their metadata against
the live utility output. It does not compare volatile timestamps or producer
versions against this historical capture.
