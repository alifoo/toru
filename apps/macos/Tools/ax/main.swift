// toru-ax: inspects what Toru for Mac reads and does through Accessibility, without the app.
//   toru-ax windows                      on-screen windows (id, pid, app, title)
//   toru-ax outline <windowID> [--full]  Jev outline of one window (--full: ask Electron/Chromium for the whole tree)
import AppKit
import ApplicationServices

func emit(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
let arguments = Array(CommandLine.arguments.dropFirst())
guard AccessibilityOutline.trusted else { FileHandle.standardError.write("accessibility_not_trusted\n".data(using: .utf8)!); exit(2) }
switch arguments.first {
case "windows":
    let info = (CGWindowListCopyWindowInfo(arguments.contains("--all") ? [.excludeDesktopElements] : [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    emit(info.compactMap { window -> [String: Any]? in
        let anyLayer = arguments.contains("--layers")
        guard anyLayer || (window[kCGWindowLayer as String] as? Int) == 0, let id = window[kCGWindowNumber as String] as? Int,
              let pid = window[kCGWindowOwnerPID as String] as? Int, let raw = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw), anyLayer || (bounds.width >= 320 && bounds.height >= 200) else { return nil }
        return ["windowID": id, "pid": pid, "app": window[kCGWindowOwnerName as String] as? String ?? "", "title": window[kCGWindowName as String] as? String ?? "",
                "bundle": NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? "", "width": Int(bounds.width), "height": Int(bounds.height)]
    })
case "outline":
    guard arguments.count >= 2, let id = UInt32(arguments[1]) else { print("usage: toru-ax outline <windowID> [--full]"); exit(1) }
    let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]])?.first
    guard let pid = info?[kCGWindowOwnerPID as String] as? Int else { print("window_not_found"); exit(1) }
    let reader = AccessibilityOutline(pid: pid_t(pid), windowID: CGWindowID(id))
    if arguments.contains("--full") { reader.enableFullTree() }
    var snapshot = reader.read()
    // Chromium builds its tree asynchronously after the flag: read again until the window has content.
    let deadline = Date().addingTimeInterval(arguments.contains("--full") ? 5 : 0)
    while Date() < deadline, (snapshot?.targets.values.filter { $0.role != "menubaritem" }.count ?? 0) < 3 {
        Thread.sleep(forTimeInterval: 0.25); snapshot = reader.read()
    }
    guard let tree = snapshot else { print("window_unreadable"); exit(1) }
    let started = Date()
    let read = arguments.contains("--visual-only") ? VisualOutline.augment(OutlineSnapshot(outline: "Scroll areas (layout only; offscreen content is not visual proof): {\"regions\":[]}", text: "", window: tree.window, targets: [:], elements: 0, milliseconds: 0), windowID: CGWindowID(id), pid: pid_t(pid), force: true)
        : arguments.contains("--visual") || arguments.contains("--fallback")
        ? VisualOutline.augment(tree, windowID: CGWindowID(id), pid: pid_t(pid), force: arguments.contains("--visual")) : tree
    emit(["outline": read.outline, "text": read.text, "elements": read.elements, "milliseconds": read.milliseconds + Int(Date().timeIntervalSince(started) * 1000),
          "identity": read.identity.map { ["x": Int($0.minX), "y": Int($0.minY), "width": Int($0.width), "height": Int($0.height)] },
          "window": ["x": read.window.minX, "y": read.window.minY, "width": read.window.width, "height": read.window.height]])
case "act":
    // toru-ax act <windowID> click <ref> | fill <ref> <text> | key <chord> | scroll <x> <y> <direction> <amount>
    guard arguments.count >= 4, let id = UInt32(arguments[1]),
          let pid = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]])?.first?[kCGWindowOwnerPID as String] as? Int else { print("usage"); exit(1) }
    let reader = AccessibilityOutline(pid: pid_t(pid), windowID: CGWindowID(id))
    guard let tree = reader.read() else { print("window_unreadable"); exit(1) }
    let before = arguments.contains("--visual-only") ? VisualOutline.augment(OutlineSnapshot(outline: "", text: "", window: tree.window, targets: [:], elements: 0, milliseconds: 0), windowID: CGWindowID(id), pid: pid_t(pid), force: true)
        : arguments.contains("--visual") ? VisualOutline.augment(tree, windowID: CGWindowID(id), pid: pid_t(pid), force: true) : tree
    let driver = InputDriver(reader: reader)
    let op = arguments[2]
    do {
        switch op {
        case "click": guard let target = before.targets[arguments[3]] else { throw InputError.notFound(arguments[3]) }; try driver.click(target, window: before.window)
        case "clicktext": guard let target = before.targets.values.first(where: { $0.label.hasSuffix("\"\(arguments[3])\"") }) else { throw InputError.notFound(arguments[3]) }; try driver.click(target, window: before.window)
        case "fill": guard let target = before.targets[arguments[3]], arguments.count >= 5 else { throw InputError.notFound(arguments[3]) }; try driver.fill(target, text: arguments[4], window: before.window)
        case "key": try driver.press(arguments[3])
        case "scroll": try driver.scroll(at: CGPoint(x: Double(arguments[3])!, y: Double(arguments[4])!), direction: arguments[5], amount: Double(arguments[6])!, window: before.window)
        default: print("unknown op"); exit(1)
        }
    } catch { print("error", error.localizedDescription); exit(3) }
    Thread.sleep(forTimeInterval: 0.3)
    let after = reader.read()
    emit(["ok": true, "telemetry": driver.telemetry.count, "timeline": driver.timeline.map { $0["type"] ?? "" }, "outline": after?.outline ?? "", "text": after?.text ?? ""])
default:
    print("usage: toru-ax windows | outline <windowID> [--full] | act <windowID> …"); exit(1)
}
