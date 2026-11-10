import AppKit

// A real window that exists and is never ordered in, so it stays off screen and
// never appears on the desktop. It expires in case its launcher loses track of it.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 240, height: 80), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "REA off-screen window fixture"
DispatchQueue.main.async {
  let record = "{\"pid\":\(ProcessInfo.processInfo.processIdentifier),\"window_id\":\(window.windowNumber)}\n"
  FileHandle.standardOutput.write(Data(record.utf8))
}
DispatchQueue.main.asyncAfter(deadline: .now() + 300) { exit(0) }
app.run()
