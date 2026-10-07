import Foundation

// Encode the root under a key that matches the UID marker spelling.
let archiver = NSKeyedArchiver(requiringSecureCoding: false)
archiver.encode("payload" as NSString, forKey: "UID")
archiver.finishEncoding()
try archiver.encodedData.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
