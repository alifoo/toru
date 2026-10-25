import ApplicationServices
import AppKit

/// A cursor sample for the renderer, in window points, like the browser driver's pointer telemetry.
struct PointerSample {
    let x: Double
    let y: Double
    let atMs: Int
    let kind: String
}

enum InputError: LocalizedError {
    case secureField, unsupported(String), notFound(String), refused(String)
    var errorDescription: String? {
        switch self {
        case .secureField: return "local_sign_in_required"
        case .unsupported(let what): return "unsupported: \(what)"
        case .notFound(let what): return "not found: \(what)"
        case .refused(let what): return "local_method_forbidden: \(what)"
        }
    }
}

/// Acts on another app's window through Accessibility, in the background.
///
/// Buttons, checkboxes, menus and rows are pressed with AXPress; text is inserted through AXSelectedText one
/// character at a time; scroll areas move through their scroll bars. None of this moves the user's cursor,
/// takes keyboard focus or needs the window to be frontmost, so the user keeps using the Mac while Toru records.
/// The recording shows a cursor drawn by Toru from the samples below, as web recordings do. Keys go to the
/// operated app only. Controls found in a screenshot (the visual fallback) are clicked through the system with the
/// pointer returning at once. Secure text fields are never typed into.
final class InputDriver {
    let pid: pid_t
    private let reader: AccessibilityOutline
    private let started: Date
    private(set) var telemetry: [PointerSample] = []
    private(set) var timeline: [[String: Any]] = []
    private var cursor: CGPoint?
    /// Characters per second while typing, so the video shows text being typed.
    /// About nine characters a second with a human jitter, the cadence a web recording types at; an even 22 a
    /// second read as machine-generated.
    func characterDelay() -> TimeInterval { 0.085 + Double.random(in: 0...0.07) }
    /// While typing the pointer rests on the field; a sample per character says the window is busy, so the render's
    /// pause trimming (which reads the cursor path) never cuts the typing out.
    private func markTyping() {
        guard let cursor else { return }
        telemetry.append(PointerSample(x: cursor.x, y: cursor.y, atMs: elapsedMs, kind: "move"))
    }

    /// Telemetry times count from `started`: the recording's start, so samples line up with the video.
    init(reader: AccessibilityOutline, started: Date = Date()) {
        self.reader = reader
        pid = reader.pid
        self.started = started
    }

    /// Where an action landed, in window points, and what it was, for click zooms and the timeline.
    private func record(_ type: String, _ target: OutlineTarget?, window: CGRect, extra: [String: Any] = [:]) {
        var entry: [String: Any] = ["type": type, "atMs": elapsedMs]
        if let target {
            entry["frame"] = CGRect(x: target.frame.minX - window.minX, y: target.frame.minY - window.minY, width: target.frame.width, height: target.frame.height)
            entry["element"] = target.label
        }
        timeline.append(entry.merging(extra) { a, _ in a })
    }

    private var elapsedMs: Int { Int(Date().timeIntervalSince(started) * 1000) }

    /// A smooth path from the last position, for the renderer's cursor and click zooms.
    func glide(to point: CGPoint, window: CGRect, kind: String) {
        let local = CGPoint(x: point.x - window.minX, y: point.y - window.minY)
        let from = cursor ?? CGPoint(x: window.width / 2, y: window.height / 2)
        // The same travel a web recording draws: 550ms plus half a millisecond per point, at most 1.2s, eased in and
        // out. A fixed 0.3s made every move a dart from one control to the next, too fast to follow.
        let travelMs = min(1_200, 550 + hypot(local.x - from.x, local.y - from.y) * 0.5)
        let steps = max(2, Int((travelMs / 16).rounded()))
        let start = elapsedMs
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            let eased = t * t * (3 - 2 * t)
            // Arriving is a move. The press is marked by markPress() when it actually happens, so the rendered cursor
            // does not press the instant it lands; `kind` names what the travel is for.
            telemetry.append(PointerSample(x: from.x + (local.x - from.x) * eased, y: from.y + (local.y - from.y) * eased, atMs: start + step * 16, kind: "move"))
        }
        cursor = local
        // The pointer arrives, then rests on the control long enough to be seen before the press, as a hand settles
        // and hover styling shows. A 160ms beat read as a dart-and-click in the rendered video.
        Thread.sleep(forTimeInterval: Double(steps) * 0.016 + 0.4)
    }

    /// The press itself, at the moment the app receives it, so the rendered cursor presses then and not on arrival.
    private func markPress() {
        let at = cursor ?? CGPoint(x: 0, y: 0)
        telemetry.append(PointerSample(x: at.x, y: at.y, atMs: elapsedMs, kind: "click"))
    }

    func click(_ target: OutlineTarget, window: CGRect) throws {
        glide(to: CGPoint(x: target.frame.midX, y: target.frame.midY), window: window, kind: "click")
        let actions = target.visual ? [] : actionNames(target.element)
        let center = CGPoint(x: target.frame.midX, y: target.frame.midY)
        let inFront = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        markPress()
        if target.visual {
            guard ownsPoint(center) else { throw InputError.refused("the window is not on screen") }
            clickAt(center)
        } else if !["textbox", "searchbox"].contains(target.role), inFront, window.contains(center), ownsPoint(center), Self.isWebContent(target.element) {
            // In web content (Electron apps such as Linear and Cursor) AXPress on links, menu items, tabs and buttons
            // is acknowledged and then ignored often enough that a recording stalls, or reports a change that never
            // happened; with the app in front and on screen, a real click where the control is always lands.
            clickAt(center)
        } else if actions.contains(kAXPressAction as String) {
            try check(AXUIElementPerformAction(target.element, kAXPressAction as CFString), "press")
        } else if target.role == "row" || target.role == "cell" {
            try check(AXUIElementSetAttributeValue(target.element, kAXSelectedAttribute as CFString, kCFBooleanTrue), "select row")
        } else if target.role == "textbox" || target.role == "searchbox" || target.role == "combobox" {
            try check(AXUIElementSetAttributeValue(target.element, kAXFocusedAttribute as CFString, kCFBooleanTrue), "focus")
        } else if target.frame.width >= 2, target.frame.height >= 2, window.contains(center), ownsPoint(center) {
            // Chromium and Electron offer AXPress on a link only some of the time (Linear's issue rows): a listed,
            // visible control is clicked where it is, as a person would, instead of the step failing.
            clickAt(CGPoint(x: target.frame.midX, y: target.frame.midY))
        } else {
            throw InputError.unsupported("click on \(target.role)")
        }
        record("click", target, window: window)
    }

    private func elementFrame(_ element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute) else { return nil }
        var point = CGPoint.zero, extent = CGSize.zero
        AXValueGetValue(position as! AXValue, .cgPoint, &point); AXValueGetValue(size as! AXValue, .cgSize, &extent)
        return CGRect(origin: point, size: extent)
    }

    /// Inside a web area (Chromium, Electron, WebKit views), where Accessibility actions are not always honoured.
    static func isWebContent(_ element: AXUIElement) -> Bool {
        var node: AXUIElement? = element
        for _ in 0..<40 {
            guard let current = node else { return false }
            var role: AnyObject?
            AXUIElementCopyAttributeValue(current, kAXRoleAttribute as CFString, &role)
            if (role as? String) == "AXWebArea" { return true }
            var parent: AnyObject?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success, let next = parent else { return false }
            node = (next as! AXUIElement)
        }
        return false
    }

    /// Replaces a field's text, typed out character by character.
    func fill(_ target: OutlineTarget, text: String, window: CGRect) throws {
        guard !target.secure else { throw InputError.secureField }
        if target.role == "combobox", (attribute(target.element, kAXRoleAttribute) as? String) == kAXPopUpButtonRole as String {
            try choose(target, option: text, window: window); return
        }
        glide(to: CGPoint(x: target.frame.midX, y: target.frame.midY), window: window, kind: "click")
        let fieldCenter = CGPoint(x: target.frame.midX, y: target.frame.midY)
        let webField = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid && Self.isWebContent(target.element) && ownsPoint(fieldCenter)
        markPress()
        if target.visual || webField {
            guard ownsPoint(fieldCenter) else { throw InputError.refused("the window is not on screen") }
            // A field seen only in pixels, or a web field (Electron apps such as Linear accept text set through
            // Accessibility and then drop it): click into it, select what is there, type over it with real keys.
            if target.visual { clickAt(fieldCenter); Thread.sleep(forTimeInterval: 0.15) } else { focusByClicking(target) }
            // A web text area is a document (a code editor, a long comment): what is typed goes at its end, never
            // over everything already in it.
            if !target.visual, (attribute(target.element, kAXRoleAttribute) as? String) == kAXTextAreaRole as String {
                try press("CMD+DOWN")
                Thread.sleep(forTimeInterval: 0.15)
                try typeKeys(text)
                record("type", target, window: window)
                return
            }
            try press("CMD+A")
            try typeKeys(text)
            record("type", target, window: window)
            return
        }
        AXUIElementSetAttributeValue(target.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let existing = (attribute(target.element, kAXValueAttribute) as? String) ?? ""
        let length = (attribute(target.element, kAXNumberOfCharactersAttribute) as? Int) ?? existing.utf16.count
        // A document (multi-line text area) gets the text added on a new line at its end; a field is replaced, as a
        // web form field is.
        let document = (attribute(target.element, kAXRoleAttribute) as? String) == kAXTextAreaRole as String
            && !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let prefix = document && !existing.hasSuffix("\n") ? "\n" : ""
        var insertion = document ? CFRange(location: length, length: 0) : CFRange(location: 0, length: length)
        if let range = AXValueCreate(.cfRange, &insertion) { AXUIElementSetAttributeValue(target.element, kAXSelectedTextRangeAttribute as CFString, range) }
        try type(prefix + text, into: target.element)
        // Some native fields (Books' toolbar search) report success and keep nothing. Read the field back; if the
        // text is not there and the app is in front, type it the way a person does.
        let landed = (attribute(target.element, kAXValueAttribute) as? String) ?? ""
        if ProcessInfo.processInfo.environment["TORU_CONTROL_LOG"] != nil {
            let point = CGPoint(x: target.frame.midX, y: target.frame.midY)
            FileHandle.standardError.write("toru fill landed=\"\(landed)\" front=\(NSWorkspace.shared.frontmostApplication?.processIdentifier == pid) owns=\(ownsPoint(point)) at=\(point)\n".data(using: .utf8)!)
        }
        if !landed.localizedCaseInsensitiveContains(text), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
           ownsPoint(CGPoint(x: target.frame.midX, y: target.frame.midY)) {
            focusByClicking(target)
            try press("CMD+A")
            try typeKeys(text)
            record("type", target, window: window)
            return
        }
        // Leave what was typed selected, as a person would before formatting it: a Bold or Center that follows
        // applies to this text rather than only to what comes next.
        var typed = CFRange(location: (document ? length : 0) + prefix.utf16.count, length: text.utf16.count)
        if let range = AXValueCreate(.cfRange, &typed) { AXUIElementSetAttributeValue(target.element, kAXSelectedTextRangeAttribute as CFString, range) }
        record("type", target, window: window)
    }

    /// Types at the field's insertion point, a character at a time.
    /// A left click at a screen point, for controls seen only in a screenshot. Many apps ignore clicks that do not
    /// come through the system, so this one does: the pointer goes to the point for the click and straight back.
    /// Only the visual fallback uses it; everything Accessibility can press stays in the background.
    /// Whether what is on screen at this point belongs to the operated app. A window can be "in front" for macOS and
    /// still not be on screen (another space, a hidden AeroSpace workspace): a click or keys there would land in
    /// whatever window is showing instead, so position-based input refuses unless the app itself is at the point.
    func ownsPoint(_ point: CGPoint) -> Bool {
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success,
              let element else { return false }
        var owner: pid_t = 0
        return AXUIElementGetPid(element, &owner) == .success && owner == pid
    }

    /// Clicks into a field until it has focus: the first click on a window that is not key often only makes it key
    /// (Books keeps a second, invisible window key), and keys typed then go to that other window.
    func focusByClicking(_ target: OutlineTarget) {
        let point = CGPoint(x: target.frame.midX, y: target.frame.midY)
        for _ in 0..<3 {
            clickAt(point)
            Thread.sleep(forTimeInterval: 0.2)
            if (attribute(target.element, kAXFocusedAttribute) as? Bool) == true { return }
        }
    }

    func clickAt(_ point: CGPoint) {
        let saved = CGEvent(source: nil)?.location
        for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { continue }
            if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
            event.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: type == .mouseMoved ? 0.03 : 0.05)
        }
        if let saved { CGWarpMouseCursorPosition(saved) }
    }

    /// Keys reach the operated app: through the system while it is in front (the recording keeps it there), straight
    /// to its process otherwise, so a key never lands in the user's own app.
    private func post(_ event: CGEvent) {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { event.post(tap: .cghidEventTap) } else { event.postToPid(pid) }
    }

    /// Text as key events to the app, a character at a time, for fields Accessibility cannot reach.
    func typeKeys(_ text: String) throws {
        let source = CGEventSource(stateID: .privateState)
        let startedInFront = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        for character in text {
            // Another app coming in front mid-word (a notification click, another agent) would silently cut the text:
            // the app is brought back and typing goes on, or the step fails instead of delivering half a sentence.
            if startedInFront, NSWorkspace.shared.frontmostApplication?.processIdentifier != pid { try regainFront() }
            // A line break is the Return key: a code editor takes a typed "\n" character as nothing at all.
            if character == "\n" || character == "\r\n" {
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: down) else { continue }
                    post(event)
                }
                markTyping(); Thread.sleep(forTimeInterval: characterDelay())
                continue
            }
            var units = Array(String(character).utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                post(event)
            }
            markTyping(); Thread.sleep(forTimeInterval: characterDelay())
        }
    }

    private func regainFront() throws {
        NSRunningApplication(processIdentifier: pid)?.activate()
        for _ in 0..<30 where NSWorkspace.shared.frontmostApplication?.processIdentifier != pid { Thread.sleep(forTimeInterval: 0.05) }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw InputError.refused("another app came in front while typing") }
        Thread.sleep(forTimeInterval: 0.15)
    }

    func type(_ text: String, into element: AXUIElement) throws {
        guard (attribute(element, kAXSubroleAttribute) as? String) != kAXSecureTextFieldSubrole as String else { throw InputError.secureField }
        // Web content takes text only from key events (it acknowledges and drops Accessibility edits).
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, Self.isWebContent(element),
           let frame = elementFrame(element), ownsPoint(CGPoint(x: frame.midX, y: frame.midY)) { try typeKeys(text); return }
        var first = true
        for character in text {
            let result = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, String(character) as CFString)
            if first, result != .success {
                // Fields without an insertion point accept a whole value instead, or else plain key events.
                if AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString) != .success { try typeKeys(text) }
                return
            }
            first = false
            markTyping(); Thread.sleep(forTimeInterval: characterDelay())
        }
    }

    /// Opens a popup button and presses the menu item with this title.
    func choose(_ target: OutlineTarget, option: String, window: CGRect) throws {
        glide(to: CGPoint(x: target.frame.midX, y: target.frame.midY), window: window, kind: "click")
        func items() -> [AXUIElement] {
            let menu = (attribute(target.element, kAXChildrenAttribute) as? [AXUIElement])?.first { (attribute($0, kAXRoleAttribute) as? String) == kAXMenuRole as String }
            return menu.flatMap { attribute($0, kAXChildrenAttribute) as? [AXUIElement] } ?? []
        }
        let wanted = option.trimmingCharacters(in: .whitespaces).lowercased()
        func match(_ list: [AXUIElement]) -> AXUIElement? {
            list.first(where: { ((attribute($0, kAXTitleAttribute) as? String) ?? "").lowercased() == wanted })
                ?? list.first(where: { ((attribute($0, kAXTitleAttribute) as? String) ?? "").lowercased().hasPrefix(wanted) })
        }
        var item = match(items())
        var opened = false
        if item == nil {
            // Most popups build their menu only while it is open.
            try check(AXUIElementPerformAction(target.element, kAXPressAction as CFString), "open popup")
            opened = true
            for _ in 0..<10 where item == nil { Thread.sleep(forTimeInterval: 0.1); item = match(items()) }
        }
        guard let item else {
            if opened { try? press("ESC") }
            throw InputError.notFound("option \(option)")
        }
        markPress()
        try check(AXUIElementPerformAction(item, kAXPressAction as CFString), "choose")
        record("click", target, window: window)
    }

    /// Scrolls the area around a window point through its scroll bar, by roughly `amount` points.
    func scroll(at point: CGPoint, direction: String, amount: Double, window: CGRect) throws {
        let screen = CGPoint(x: window.minX + point.x, y: window.minY + point.y)
        var hit: AXUIElement?
        let system = AXUIElementCreateSystemWide()
        AXUIElementCopyElementAtPosition(system, Float(screen.x), Float(screen.y), &hit)
        var area = hit
        while let current = area, (attribute(current, kAXRoleAttribute) as? String) != kAXScrollAreaRole as String {
            area = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
        }
        let vertical = direction == "up" || direction == "down"
        // Web content (Chromium, Electron) scrolls its containers with the wheel and lists no scroll area or scroll bar:
        // with the app in front and on screen there, the wheel turns where the region is, as a person would scroll it.
        let wheelable = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid && window.contains(screen) && ownsPoint(screen)
        if wheelable, area.map({ attribute($0, vertical ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute) == nil }) ?? true {
            glide(to: screen, window: window, kind: "move")
            wheel(by: (direction == "down" || direction == "right" ? 1 : -1) * amount, vertical: vertical)
            record("scroll", nil, window: window)
            return
        }
        // A hidden window has nothing at the point; fall back to the largest scroll area of the window.
        if area == nil { area = largestScrollArea(window: window) }
        guard let scrollArea = area else { throw InputError.notFound("scroll area") }
        guard let barObject = attribute(scrollArea, vertical ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute) else { throw InputError.unsupported("no scroll bar") }
        let bar = barObject as! AXUIElement
        let value = (attribute(bar, kAXValueAttribute) as? Double) ?? 0
        let visible = reader.frame(of: scrollArea) ?? window
        let content = (attribute(scrollArea, kAXContentsAttribute) as? [AXUIElement])?.first.flatMap { reader.frame(of: $0) }
        let overflow = max(1, vertical ? (content?.height ?? visible.height * 2) - visible.height : (content?.width ?? visible.width * 2) - visible.width)
        let delta = (direction == "down" || direction == "right" ? 1 : -1) * amount / overflow
        let target = min(1, max(0, value + delta))
        // Several small steps read as a scroll in the video rather than a jump.
        for step in 1...8 {
            let next = value + (target - value) * Double(step) / 8
            AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next))
            Thread.sleep(forTimeInterval: 0.03)
        }
        record("scroll", nil, window: window)
    }

    /// Pixel wheel steps eased over about half a second, so the content glides instead of jumping.
    private func wheel(by pixels: Double, vertical: Bool) {
        let steps = 24
        var sent = 0.0
        for step in 1...steps {
            let progress = Double(step) / Double(steps)
            let eased = progress * progress * (3 - 2 * progress)
            let delta = (pixels * eased - sent).rounded()
            sent += delta
            // The wheel's positive direction moves the content down (scrolls up).
            let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                wheel1: vertical ? Int32(-delta) : 0, wheel2: vertical ? 0 : Int32(-delta), wheel3: 0)
            event?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.022)
        }
        Thread.sleep(forTimeInterval: 0.2)
    }

    private func largestScrollArea(window: CGRect) -> AXUIElement? {
        guard let root = reader.window() else { return nil }
        var best: (AXUIElement, CGFloat)?
        var queue = [root], visited = 0
        while !queue.isEmpty, visited < 1500 {
            let node = queue.removeFirst(); visited += 1
            if (attribute(node, kAXRoleAttribute) as? String) == kAXScrollAreaRole as String, let frame = reader.frame(of: node) {
                let size = frame.width * frame.height
                if size > (best?.1 ?? 0) { best = (node, size) }
            }
            queue += (attribute(node, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        }
        return best?.0
    }

    /// Keys from the same allowlist as the browser companion, sent to the app process only.
    func press(_ chord: String) throws {
        for part in chord.split(separator: " ") {
            var tokens = part.uppercased().split(separator: "+").map(String.init)
            guard let base = tokens.popLast(), let code = Self.keyCodes[base] ?? Self.letterCode(base) else { throw InputError.refused(String(part)) }
            var flags = CGEventFlags()
            for modifier in tokens {
                switch modifier {
                case "SHIFT": flags.insert(.maskShift)
                case "CMD", "COMMAND", "META", "CTRL", "CONTROL": flags.insert(.maskCommand)
                default: throw InputError.refused(modifier)
                }
            }
            // Command shortcuts are limited to undo, redo, select all, submit and moving the caret to a document's
            // start or end, like the browser driver.
            if flags.contains(.maskCommand), !["A", "Z", "Y", "ENTER", "RETURN", "UP", "DOWN", "ARROWUP", "ARROWDOWN"].contains(base) { throw InputError.refused(String(part)) }
            let source = CGEventSource(stateID: .privateState)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
                event.flags = flags
                post(event)
                Thread.sleep(forTimeInterval: 0.02)
            }
        }
        timeline.append(["type": "key", "atMs": elapsedMs, "element": chord])
    }

    static let keyCodes: [String: CGKeyCode] = [
        "ENTER": 36, "RETURN": 36, "TAB": 48, "SPACE": 49, "BACKSPACE": 51, "DELETE": 117, "ESC": 53, "ESCAPE": 53,
        "LEFT": 123, "ARROWLEFT": 123, "RIGHT": 124, "ARROWRIGHT": 124, "DOWN": 125, "ARROWDOWN": 125, "UP": 126, "ARROWUP": 126,
        "HOME": 115, "END": 119, "PAGEUP": 116, "PAGEDOWN": 121,
    ]
    static func letterCode(_ key: String) -> CGKeyCode? {
        let letters: [Character: CGKeyCode] = ["A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
                                              "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "O": 31, "U": 32,
                                              "I": 34, "P": 35, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46]
        guard key.count == 1, let character = key.first else { return nil }
        return letters[character]
    }

    // MARK: helpers

    private func check(_ result: AXError, _ what: String) throws {
        guard result == .success else { throw InputError.unsupported("\(what) (\(result.rawValue))") }
    }
    private func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        return AXUIElementCopyActionNames(element, &names) == .success ? (names as? [String]) ?? [] : []
    }
}
