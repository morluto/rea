import { describe, expect, it } from "vitest";
import {
  parseHidReportDescriptor,
  HID_USAGE_PAGE_NAMES,
} from "./hidReportDescriptor.js";

describe("HID Report Descriptor - Parsing and Layout", () => {
  it("decodes standard keyboard input report descriptor items", () => {
    const descriptor = [
      0x05,
      0x01, // Usage Page (Generic Desktop)
      0x09,
      0x06, // Usage (Keyboard)
      0xa1,
      0x01, // Collection (Application)
      0x85,
      0x01, // Report ID (1)
      0x05,
      0x07, // Usage Page (Key Codes)
      0x19,
      0xe0, // Usage Minimum (224)
      0x29,
      0xe7, // Usage Maximum (231)
      0x15,
      0x00, // Logical Minimum (0)
      0x25,
      0x01, // Logical Maximum (1)
      0x75,
      0x01, // Report Size (1 bit)
      0x95,
      0x08, // Report Count (8)
      0x81,
      0x02, // Input (Data, Variable, Absolute)
      0xc0, // End Collection
    ];

    const result = parseHidReportDescriptor(descriptor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);

    expect(result.value.items.length).toBeGreaterThan(5);
    expect(result.value.reports.length).toBe(1);
    expect(result.value.collections.length).toBe(1);
    expect(result.value.collections[0]?.usagePage).toBe(0x01);
    expect(result.value.collections[0]?.usage).toBe(0x06);

    const report = result.value.reports[0];
    if (!report) throw new Error("Expected input report");
    expect(report.reportId).toBe(1);
    expect(report.reportType).toBe("input");
    expect(report.fields[0]?.usagePage).toBe(0x07);
    expect(report.fields[0]?.reportSizeBits).toBe(1);
    expect(report.fields[0]?.reportCount).toBe(8);
    // 8 bits payload + 1 byte report ID = 2 bytes total
    expect(report.totalSizeBytes).toBe(2);
    // Issue 6: Collection usage does not leak into modifier field
    expect(report.fields[0]?.usage).toBeNull();
    expect(report.fields[0]?.usages).toEqual([]);
    expect(report.fields[0]?.usageMin).toBe(0xe0);
    expect(report.fields[0]?.usageMax).toBe(0xe7);
  });

  it("accumulates multiple field groups into a single endpoint report (Issue 5)", () => {
    // Report ID 1 has two 8-bit Input groups (modifier byte + keycode byte)
    const multiFieldDescriptor = [
      0x05,
      0x01, // Usage Page (Generic Desktop)
      0x09,
      0x06, // Usage (Keyboard)
      0xa1,
      0x01, // Collection (Application)
      0x85,
      0x01, // Report ID (1)
      0x75,
      0x08, // Report Size (8 bits)
      0x95,
      0x01, // Report Count (1)
      0x81,
      0x02, // Input 1
      0x75,
      0x08, // Report Size (8 bits)
      0x95,
      0x01, // Report Count (1)
      0x81,
      0x02, // Input 2
      0xc0, // End Collection
    ];

    const result = parseHidReportDescriptor(multiFieldDescriptor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);

    // Accumulated into single Input report under Report ID 1
    expect(result.value.reports.length).toBe(1);
    const report = result.value.reports[0];
    if (!report) throw new Error("Expected input report");
    expect(report.reportId).toBe(1);
    // 16 bits (2 bytes) payload + 1 byte report ID = 3 bytes total
    expect(report.totalBits).toBe(16);
    expect(report.totalSizeBytes).toBe(3);
    expect(report.fields.length).toBe(2);
    expect(report.fields[0]?.bitOffset).toBe(0);
    expect(report.fields[1]?.bitOffset).toBe(8);
  });

  it("correctly models mixed-size field layouts without contradictory report sizes", () => {
    // Report ID 3: two 8-bit fields (16 bits) followed by eight 1-bit fields (8 bits) = 24 bits total
    const mixedDescriptor = [
      0x85,
      0x03, // Report ID (3)
      0x75,
      0x08, // Report Size (8 bits)
      0x95,
      0x02, // Report Count (2)
      0x81,
      0x02, // Input (16 bits)
      0x75,
      0x01, // Report Size (1 bit)
      0x95,
      0x08, // Report Count (8)
      0x81,
      0x02, // Input (8 bits)
    ];

    const result = parseHidReportDescriptor(mixedDescriptor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);

    const report = result.value.reports[0];
    if (!report) throw new Error("Expected mixed report");
    expect(report.totalBits).toBe(24);
    // 24 bits / 8 = 3 bytes + 1 byte report ID = 4 bytes total
    expect(report.totalSizeBytes).toBe(4);
    expect(report.fields.length).toBe(2);

    expect(report.fields[0]?.reportSizeBits).toBe(8);
    expect(report.fields[0]?.reportCount).toBe(2);
    expect(report.fields[0]?.bitOffset).toBe(0);
    expect(report.fields[0]?.bitLength).toBe(16);

    expect(report.fields[1]?.reportSizeBits).toBe(1);
    expect(report.fields[1]?.reportCount).toBe(8);
    expect(report.fields[1]?.bitOffset).toBe(16);
    expect(report.fields[1]?.bitLength).toBe(8);
  });
});

describe("HID Report Descriptor - Usage Lists and Collections", () => {
  it("preserves explicit local usage lists across multi-count fields without loss", () => {
    const buttonDescriptor = [
      0x05,
      0x09, // Usage Page (Button)
      0x09,
      0x01, // Usage (1)
      0x09,
      0x02, // Usage (2)
      0x09,
      0x03, // Usage (3)
      0x75,
      0x01, // Report Size (1 bit)
      0x95,
      0x03, // Report Count (3)
      0x81,
      0x02, // Input
    ];

    const result = parseHidReportDescriptor(buttonDescriptor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);

    const report = result.value.reports[0];
    if (!report) throw new Error("Expected report");
    const field = report.fields[0];
    if (!field) throw new Error("Expected field");
    expect(field.usage).toBe(1);
    expect(field.usages).toEqual([1, 2, 3]);
    expect(field.usagesHex).toEqual(["0x1", "0x2", "0x3"]);
  });
});

describe("HID Report Descriptor - Global Stack and Long Items", () => {
  it("handles Push and Pop global item stack (Issue 7)", () => {
    const pushPopDescriptor = [
      0x85,
      0x01, // Report ID (1)
      0x75,
      0x08, // Report Size (8 bits)
      0xa4, // Push
      0x85,
      0x02, // Report ID (2)
      0x75,
      0x10, // Report Size (16 bits)
      0xb4, // Pop (restores Report ID 1, Report Size 8)
      0x95,
      0x01, // Report Count (1)
      0x81,
      0x02, // Input
    ];

    const result = parseHidReportDescriptor(pushPopDescriptor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);

    expect(result.value.reports.length).toBe(1);
    const report = result.value.reports[0];
    if (!report) throw new Error("Expected input report");
    // Pop restored Report ID 1 and Report Size 8
    expect(report.reportId).toBe(1);
    expect(report.fields[0]?.reportSizeBits).toBe(8);
  });

  it("skips 0xFE long-item payloads without corrupting item parsing (Issue 8)", () => {
    // Long item tag 0x01 with 2 payload bytes (0x85, 0x07) that must NOT set Report ID to 7
    const longItemDescriptor = [
      0x85,
      0x01, // Report ID (1)
      0xfe,
      0x02,
      0x01,
      0x85,
      0x07, // Long item with 2 bytes payload
      0x75,
      0x08, // Report Size (8 bits)
      0x95,
      0x01, // Report Count (1)
      0x81,
      0x02, // Input
    ];

    const result = parseHidReportDescriptor(longItemDescriptor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);

    expect(result.value.reports.length).toBe(1);
    const report = result.value.reports[0];
    if (!report) throw new Error("Expected input report");
    expect(report.reportId).toBe(1); // Not 7!
  });
});

describe("HID Report Descriptor - Validation and Vendor Extensions", () => {
  it("rejects invalid or negative byte arrays without hanging (Issue 1)", () => {
    const invalidDescriptor = [0xfe, -3, 1];
    const result = parseHidReportDescriptor(invalidDescriptor);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure for negative byte");
    expect(result.error.reason).toContain("invalid byte value at index 1");
    expect(result.error.offset).toBe(1);
  });

  it("returns failure on truncated descriptor items (Issue 9)", () => {
    // Item 0x81 (Input) requires 1 byte of flags, but ends prematurely
    const truncated = [0x75, 0x08, 0x95, 0x01, 0x81];
    const result = parseHidReportDescriptor(truncated);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure on truncated item");
    expect(result.error.reason).toContain("truncated item 0x81");
  });

  it("preserves 4-byte unsigned usages without signed 32-bit negative hex (Issue 10)", () => {
    // 4-byte usage 0xFF130001: bTag 0 (Usage), bType 2 (Local), bSize 3 (4 bytes) => 0x0B
    const fourByteUsage = [
      0x05,
      0x01, // Usage Page (Generic Desktop)
      0x0b,
      0x01,
      0x00,
      0x13,
      0xff, // Usage (0xFF130001: Page 0xFF13, Usage 1)
      0x75,
      0x08,
      0x95,
      0x01,
      0x81,
      0x02,
    ];

    const result = parseHidReportDescriptor(fourByteUsage);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);

    const report = result.value.reports[0];
    if (!report) throw new Error("Expected report");
    // Resolved from 4-byte extended usage width
    expect(report.fields[0]?.usagePage).toBe(0xff13);
    expect(report.fields[0]?.usagePageHex).toBe("0xFF13");
    expect(report.fields[0]?.usage).toBe(1);
    expect(report.fields[0]?.usageHex).toBe("0x1");
    expect(result.value.vendorUsagePages).toContain("0xFF13");

    // Raw unsigned 32-bit value preserved in items
    const rawUsage = result.value.items.find(
      (item) => item.type === "local" && item.tag === 0,
    );
    expect(rawUsage?.data).toBe(0xff130001);
  });

  it("resolves four-byte extended usage page and ID for vendor collections", () => {
    // Greptile fixture: extended 4-byte usage 0xFF130001 inside Generic Desktop overrides page for collection
    const vendorCollection = [
      0x05,
      0x01, // Usage Page (Generic Desktop: 0x01)
      0x0b,
      0x01,
      0x00,
      0x13,
      0xff, // Usage (4-byte: 0xFF130001 => Page 0xFF13, Usage 1)
      0xa1,
      0x01, // Collection (Application: 0x01)
      0xc0, // End Collection
    ];

    const result = parseHidReportDescriptor(vendorCollection);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);

    expect(result.value.collections.length).toBe(1);
    const col = result.value.collections[0];
    if (!col) throw new Error("Expected collection");
    expect(col.usagePage).toBe(0xff13);
    expect(col.usagePageHex).toBe("0xFF13");
    expect(col.usage).toBe(1);
    expect(col.usageHex).toBe("0x1");
    expect(result.value.vendorUsagePages).toContain("0xFF13");

    // Raw value preserved in items
    const rawUsage = result.value.items.find(
      (item) => item.type === "local" && item.tag === 0,
    );
    expect(rawUsage?.data).toBe(0xff130001);
  });

  it("identifies custom hardware vendor usage pages (e.g. 0xFF13 for Aula keyboard configuration)", () => {
    const vendorDescriptor = [
      0x06,
      0x13,
      0xff, // Usage Page (Vendor Defined 0xFF13)
      0x09,
      0x01, // Usage (1)
      0xa1,
      0x01, // Collection (Application)
      0x15,
      0x00, // Logical Minimum (0)
      0x26,
      0xff,
      0x00, // Logical Maximum (255)
      0x75,
      0x08, // Report Size (8 bits)
      0x95,
      0x40, // Report Count (64 bytes)
      0xb1,
      0x02, // Feature (Data, Variable, Absolute)
      0xc0, // End Collection
    ];

    const result = parseHidReportDescriptor(vendorDescriptor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);

    expect(result.value.vendorUsagePages).toContain("0xFF13");
    expect(result.value.reports.length).toBe(1);

    const feature = result.value.reports[0];
    if (!feature) throw new Error("Expected feature report");
    expect(feature.reportType).toBe("feature");
    expect(feature.fields[0]?.usagePage).toBe(0xff13);
    expect(feature.fields[0]?.reportSizeBits).toBe(8);
    expect(feature.fields[0]?.reportCount).toBe(64);
    expect(feature.totalSizeBytes).toBe(64);
  });

  it("maps well-known usage page names", () => {
    expect(HID_USAGE_PAGE_NAMES[0x01]).toBe("Generic Desktop Controls");
    expect(HID_USAGE_PAGE_NAMES[0x07]).toBe("Keyboard/Keypad");
    expect(HID_USAGE_PAGE_NAMES[0x0c]).toBe("Consumer");
  });
});
