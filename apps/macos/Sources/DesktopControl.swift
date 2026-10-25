import ApplicationServices
import AppKit

/// Lets Toru's navigator operate the one shared window, when the user turned it on in Settings.
///
/// Answers the same page methods as the browser companion (readPage, pageText, pointer, formInput, typeText,
/// pressKey, scrollBy), through Accessibility, in the background: the user's cursor and keyboard focus are never
/// taken. Apps that hold credentials or control the Mac are refused, and so are secure text fields.
final class DesktopControl: @unchecked Sendable {
    /// Never operated: terminals, password managers, system settings, Toru itself.
    static let denied: Set<String> = [
        "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "org.alacritty", "dev.warp.Warp-Stable", "net.kovidgoyal.kitty",
        "com.apple.keychainaccess", "com.apple.Passwords", "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
        "com.apple.systempreferences", "com.apple.SystemProfiler", "com.apple.ActivityMonitor", "com.apple.ScriptEditor2", "tools.toru.mac",
    ]
    static var available: Bool { AXIsProcessTrusted() }
    /// The page methods this class answers; the app keeps sharing when one of them fails.
    static let methods: Set<String> = ["readPage", "pageText", "pointer", "formInput", "typeText", "pressKey", "scrollBy", "redactSensitiveText"]
    /// Asks macOS for the Accessibility permission (opens the system prompt once).
    static func requestPermission() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    let pid: pid_t
    let bundle: String
    let windowID: CGWindowID
    private let reader: AccessibilityOutline
    private var driver: InputDriver
    private var snapshot: OutlineSnapshot?
    private let lock = NSLock()
    /// The window's size at the last read, in points: telemetry is a fraction of it.
    private(set) var windowSize = CGSize(width: 1, height: 1)

    init(windowID: CGWindowID) throws {
        guard Self.available else { throw ToruError(message: "local_method_forbidden: Accessibility permission is off") }
        guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
              let owner = info[kCGWindowOwnerPID as String] as? Int else { throw ToruError(message: "Source unavailable") }
        pid = pid_t(owner)
        self.windowID = windowID
        bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "unknown"
        guard !Self.denied.contains(bundle) else { throw ToruError(message: "local_method_forbidden: Toru does not operate this app") }
        reader = AccessibilityOutline(pid: pid, windowID: windowID)
        reader.enableFullTree()
        driver = InputDriver(reader: reader)
    }

    /// The app that was in front before the recording, given focus back when it ends.
    private var previous: NSRunningApplication?
    private var recording = false
    private var recordingStarted: Date?
    /// Where each read during the recording found the user's name, so the render can blur it.
    private var sightings: [[String: Any]] = []

    /// Where the window sits inside the recorded region, in points, when the recording keeps a margin around it.
    private var placement: (offset: CGPoint, region: CGSize)?

    /// Telemetry from here on lines up with the recording that starts now.
    func beginRecording(at start: Date) {
        lock.withLock { driver = InputDriver(reader: reader, started: start); recording = true; recordingStarted = start; sightings = []; placement = nil }
        bringForward()
    }
    /// Many apps apply toolbar and menu actions to the active window only (TextEdit's Bold does nothing in the
    /// background). During a recording the operated app is kept in front of its own screen; the user's mouse is
    /// never moved, and focus returns to their app when the recording ends.
    private func bringForward() {
        guard recording, let target = NSRunningApplication(processIdentifier: pid) else { return }
        // The shared window, not just its app: Books keeps a second, invisible window key, and keys and clicks went
        // there while the recorded one sat inactive.
        if let window = reader.window() {
            AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        }
        let front = NSWorkspace.shared.frontmostApplication
        guard front?.processIdentifier != pid else { return }
        if previous == nil, let front, front.processIdentifier != ProcessInfo.processInfo.processIdentifier { previous = front }
        // NSRunningApplication.activate() from a background app is ignored since macOS 14; Accessibility is not.
        if AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue) != .success { target.activate() }
        Thread.sleep(forTimeInterval: 0.25)
    }
    func endRecording() {
        let restore = lock.withLock { () -> NSRunningApplication? in
            recording = false
            defer { previous = nil }
            return previous
        }
        if let restore, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
           AXUIElementSetAttributeValue(AXUIElementCreateApplication(restore.processIdentifier), kAXFrontmostAttribute as CFString, kCFBooleanTrue) != .success { restore.activate() }
    }

    func handle(_ method: String, _ args: [Any]) throws -> Any {
        if ["pointer", "formInput", "typeText", "pressKey", "scrollBy"].contains(method) { bringForward() }
        if ProcessInfo.processInfo.environment["TORU_CONTROL_LOG"] != nil {
            let ref = (args.dropFirst().first as? [String: Any])?["ref"] as? String ?? args.first as? String ?? ""
            let target = snapshot?.targets[ref]
            FileHandle.standardError.write("toru control \(method) \(ref) \(target?.label ?? "") visual=\(target?.visual ?? false) front=\(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?")\n".data(using: .utf8)!)
        }
        let result = try lock.withLock { try perform(method, args) }
        // A beat after each visible step, so the video shows its result before the next one starts.
        if ["pointer", "formInput", "typeText", "pressKey", "scrollBy"].contains(method) { Thread.sleep(forTimeInterval: 0.6) }
        return result
    }

    private func read() throws -> OutlineSnapshot {
        // Apps listed in the visualOnlyApps preference are read from pixels only, as if they had no tree.
        let visualOnly = (UserDefaults.standard.stringArray(forKey: "visualOnlyApps") ?? []).contains(bundle)
        let canvas = visualOnly || VisualOutline.canvasApps.contains(bundle)
        var tree = visualOnly ? nil : reader.read()
        // Electron and Chromium build their tree a moment after the first request; canvas apps never do.
        for _ in 0..<(canvas ? 0 : 12) where (tree?.targets.values.filter { $0.role != "menubaritem" }.count ?? 0) < 1 {
            Thread.sleep(forTimeInterval: 0.25); tree = reader.read()
        }
        // No window in the tree at all (Figma): start from the window's frame as the window server reports it.
        if tree == nil, let bounds = AccessibilityOutline.bounds(of: windowID) {
            tree = OutlineSnapshot(outline: "Scroll areas (layout only; offscreen content is not visual proof): {\"regions\":[]}", text: "", window: bounds, targets: [:], elements: 0, milliseconds: 0)
        }
        guard let tree else { throw ToruError(message: "The shared window cannot be read. Bring it back on screen.") }
        // Little or nothing in the tree (canvas apps, closed Electron apps): read the window's pixels as well.
        let current = VisualOutline.augment(tree, windowID: windowID, pid: pid, force: canvas)
        snapshot = current
        windowSize = current.window.size
        if recording, let started = recordingStarted, sightings.count < 2_000 {
            let w = max(1, current.window.width), h = max(1, current.window.height)
            sightings.append(["atMs": max(0, Int(Date().timeIntervalSince(started) * 1000)),
                              "rects": current.identity.map { ["x": $0.minX / w, "y": $0.minY / h, "width": $0.width / w, "height": $0.height / h] }])
        }
        return current
    }
    private func target(_ ref: Any?) throws -> (OutlineTarget, CGRect) {
        guard let ref = ref as? String else { throw ToruError(message: "local_method_forbidden: missing ref") }
        let current = try snapshot ?? read()
        guard let target = current.targets[ref] else { throw ToruError(message: "stale element reference") }
        return (target, current.window)
    }

    private func perform(_ method: String, _ args: [Any]) throws -> Any {
        switch method {
        case "currentUrl":
            return "https://toru.tools/desktop/\(bundle)"
        case "readPage":
            return try read().outline
        case "pageText":
            // Reading the text must not renumber the controls the navigator is about to act on: Electron trees grow
            // between reads, so a fresh snapshot here sent "Issues" to whatever ref_26 had become ("Agent").
            let kept = snapshot
            let text = try read().text
            if let kept { snapshot = kept }
            return text
        case "pointer":
            let action = args.first as? String ?? "left_click"
            let spec = args.count > 1 ? args[1] as? [String: Any] : nil
            let current = try snapshot ?? read()
            let resolved: OutlineTarget
            if spec?["type"] as? String == "ref" {
                resolved = try target(spec?["ref"]).0
            } else if let x = spec?["x"] as? Double, let y = spec?["y"] as? Double {
                let point = CGPoint(x: current.window.minX + x, y: current.window.minY + y)
                // The smallest listed control under the point.
                guard let hit = current.targets.values.filter({ $0.frame.contains(point) && $0.role != "menubaritem" }).min(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                    if action == "move" { driver.glide(to: point, window: current.window, kind: "move"); return NSNull() }
                    // A code editor's text is one canvas with no control per line: a click where the caret should go is
                    // what a person does, so it is made when the operated app is what is on screen at that point.
                    guard current.window.contains(point), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, driver.ownsPoint(point) else {
                        throw ToruError(message: "Nothing to click at that point")
                    }
                    driver.glide(to: point, window: current.window, kind: "click")
                    driver.clickAt(point)
                    snapshot = nil
                    return NSNull()
                }
                resolved = hit
            } else { throw ToruError(message: "local_method_forbidden: invalid pointer target") }
            switch action {
            case "move", "hover": driver.glide(to: CGPoint(x: resolved.frame.midX, y: resolved.frame.midY), window: current.window, kind: "move")
            case "double_click": try driver.click(resolved, window: current.window); try driver.click(resolved, window: current.window)
            default: try driver.click(resolved, window: current.window)
            }
            snapshot = nil
            return NSNull()
        case "formInput":
            let (resolved, window) = try target(args.first)
            let value = args.count > 1 ? args[1] : ""
            if ["checkbox", "switch", "radio"].contains(resolved.role) {
                let wanted = (value as? Bool) ?? ["true", "on", "yes", "1", "checked"].contains("\(value)".lowercased())
                let state = (try? attributeInt(resolved.element, kAXValueAttribute)) ?? 0
                if (state == 1) != wanted { try driver.click(resolved, window: window) }
            } else {
                try driver.fill(resolved, text: "\(value)", window: window)
            }
            snapshot = nil
            return NSNull()
        case "typeText":
            guard let text = args.first as? String else { throw ToruError(message: "local_method_forbidden") }
            let app = AXUIElementCreateApplication(pid)
            var focused: AnyObject?
            guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) == .success, let element = focused else {
                throw ToruError(message: "No text field is focused")
            }
            try driver.type(text, into: element as! AXUIElement)
            snapshot = nil
            return NSNull()
        case "pressKey":
            guard let key = args.first as? String else { throw ToruError(message: "local_method_forbidden") }
            try driver.press(key)
            snapshot = nil
            return NSNull()
        case "scrollBy":
            let spec = args.first as? [String: Any]
            let current = try snapshot ?? read()
            let x = spec?["x"] as? Double ?? current.window.width / 2, y = spec?["y"] as? Double ?? current.window.height / 2
            try driver.scroll(at: CGPoint(x: x, y: y), direction: args.count > 1 ? (args[1] as? String ?? "down") : "down",
                              amount: args.count > 2 ? (args[2] as? Double ?? 400) : 400, window: current.window)
            snapshot = nil
            return NSNull()
        case "redactSensitiveText":
            // Desktop captures are user-approved and unredacted; secure fields are never typed into or read.
            return NSNull()
        default:
            throw ToruError(message: "local_method_forbidden")
        }
    }

    private func attributeInt(_ element: AXUIElement, _ name: String) throws -> Int {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let number = value as? Int else { throw ToruError(message: "no value") }
        return number
    }

    /// The recording is the window with a margin around it (`region`, screen points): telemetry is placed inside it.
    func place(window: CGRect, region: CGRect?) {
        lock.withLock {
            placement = region.map { (CGPoint(x: window.minX - $0.minX, y: window.minY - $0.minY), $0.size) }
        }
    }

    /// Cursor path, clicks and actions in the renderer's format (fractions of the recorded frame: the window, or the
    /// region around it; ms from the recording start).
    func telemetry() -> (pointer: [[String: Any]], trail: [[String: Any]], timeline: [[String: Any]], identity: [[String: Any]]) {
        lock.withLock {
            let ww = max(1, windowSize.width), wh = max(1, windowSize.height)
            // Window points to frame fractions.
            let ox = placement?.offset.x ?? 0, oy = placement?.offset.y ?? 0
            let w = max(1, placement?.region.width ?? ww), h = max(1, placement?.region.height ?? wh)
            func fx(_ x: CGFloat) -> CGFloat { (x + ox) / w }
            func fy(_ y: CGFloat) -> CGFloat { (y + oy) / h }
            var pointer: [[String: Any]] = []
            for sample in driver.telemetry {
                let x = min(1, max(0, fx(sample.x))), y = min(1, max(0, fy(sample.y)))
                if sample.kind == "click" {
                    pointer.append(["atMs": sample.atMs, "x": x, "y": y, "kind": "down", "shape": "hand"])
                    pointer.append(["atMs": sample.atMs + 60, "x": x, "y": y, "kind": "up", "shape": "hand"])
                } else {
                    pointer.append(["atMs": sample.atMs, "x": x, "y": y, "kind": "move", "shape": "arrow"])
                }
            }
            var trail: [[String: Any]] = []
            var timeline: [[String: Any]] = []
            for entry in driver.timeline {
                let atMs = entry["atMs"] as? Int ?? 0
                var action: [String: Any] = ["atMs": atMs, "type": entry["type"] as? String ?? "action", "ref": NSNull(), "element": entry["element"] as? String ?? ""]
                if let frame = entry["frame"] as? CGRect {
                    let focus: [String: Any] = ["x": fx(frame.minX), "y": fy(frame.minY), "width": frame.width / w, "height": frame.height / h]
                    action["focus"] = focus
                    if entry["type"] as? String == "click" {
                        trail.append(["atMs": atMs, "x": fx(frame.midX), "y": fy(frame.midY), "shape": "hand", "width": frame.width / w, "height": frame.height / h])
                    }
                }
                timeline.append(action)
            }
            // The flow ends on its result: a moment after the last step the camera opens up to the whole window,
            // the way a web recording ends on the result it was asked for.
            if let last = timeline.last?["atMs"] as? Int {
                timeline.append(["atMs": last + 300, "type": "result", "ref": NSNull(), "element": "window",
                                 "focus": ["x": fx(0), "y": fy(0), "width": ww / w, "height": wh / h]])
            }
            // Sightings are fractions of the window as it was read.
            let identity = placement == nil ? sightings : sightings.map { sighting -> [String: Any] in
                var placed = sighting
                placed["rects"] = (sighting["rects"] as? [[String: CGFloat]] ?? []).map { rect in
                    ["x": fx((rect["x"] ?? 0) * ww), "y": fy((rect["y"] ?? 0) * wh), "width": (rect["width"] ?? 0) * ww / w, "height": (rect["height"] ?? 0) * wh / h]
                }
                return placed
            }
            return (pointer, trail, timeline, identity)
        }
    }
}
