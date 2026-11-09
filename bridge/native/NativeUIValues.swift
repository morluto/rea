import Foundation
import CoreFoundation

struct AccessibilityValue {
  let value: Any
  let gap: String?
}

/** Preserve JSON scalars; report successful reads that JSON cannot represent faithfully. */
func captureAccessibilityValue(_ source: Any?) -> AccessibilityValue {
  guard let source else { return AccessibilityValue(value: NSNull(), gap: nil) }
  if let text = source as? String { return AccessibilityValue(value: text, gap: nil) }
  if let number = source as? NSNumber {
    if CFGetTypeID(number) == CFBooleanGetTypeID() {
      return AccessibilityValue(value: number.boolValue, gap: nil)
    }
    let value = number.doubleValue
    let encoding = String(cString: number.objCType)
    let floating = encoding == "f" || encoding == "d"
    if number is NSDecimalNumber || !value.isFinite || (value == 0 && value.sign == .minus) || (!floating && abs(value) > 9_007_199_254_740_991) {
      return AccessibilityValue(value: NSNull(), gap: "AXValue number \(number.stringValue) cannot be represented faithfully as a JSON number")
    }
    return AccessibilityValue(value: number, gap: nil)
  }
  return AccessibilityValue(value: NSNull(), gap: "AXValue type \(type(of: source)) is not a supported JSON scalar")
}

/** Keep an unavailable action list distinct from a successful empty list. */
func captureActionNames(status: Int32, success: Int32, names: [String]?) -> (names: [String], error: Int32?) {
  guard status == success else { return ([], status) }
  return (names ?? [], nil)
}

/** AX absence is distinct from a failed attribute read. */
func captureAttributeValue<Value>(status: Int32, success: Int32, absent: [Int32], value: Value?) -> (value: Value?, error: Int32?) {
  if status == success { return (value, nil) }
  if absent.contains(status) { return (nil, nil) }
  return (nil, status)
}
