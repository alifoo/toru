import ApplicationServices
import AppKit

/// One control Jev can act on, kept until the next read.
struct OutlineTarget {
    let element: AXUIElement
    /// Screen rectangle in global display points (origin top-left of the main display).
    let frame: CGRect
    let role: String
    let secure: Bool
    /// `role "name"`, for the recording's timeline.
    var label: String = ""
    /// Found in a screenshot rather than the Accessibility tree: acted on by position.
    var visual: Bool = false
}

/// What Jev reads: the same outline the browser driver produces, so the navigator runs unchanged.
struct OutlineSnapshot {
    let outline: String
    let text: String
    let window: CGRect
    let targets: [String: OutlineTarget]
    let elements: Int
    let milliseconds: Int
    /// Where the window shows who the user is (their account name, with the picture beside it), in window points.
    var identity: [CGRect] = []
    /// The window holds web content (Electron, Chromium, WebKit views), whose tree names what it shows.
    var web = false
}

/// Reads one window of another app through the Accessibility API.
///
/// Lines follow `browser-toolset.ts`: `[ref_N] role "name" states value="…" options=[…] in "scope" — location`,
/// headed by `Scroll areas {…}`. Coordinates are window points, the space the recording and Jev's clicks use.
/// Secure text fields are listed with the `secure` state and never have their value read.
final class AccessibilityOutline {
    let pid: pid_t
    let windowID: CGWindowID?
    private let app: AXUIElement
    private let nodeLimit = 4_000
    /// The document the read window shows ("README.md" of "README.md — toru-skills"), to name its editor.
    private var document: String?
    private let textLimit = 6_000

    init(pid: pid_t, windowID: CGWindowID? = nil) {
        self.pid = pid
        self.windowID = windowID
        app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0)
    }

    static var trusted: Bool { AXIsProcessTrusted() }

    /// Chromium and Electron apps build their full tree only when an assistive client asks for it.
    func enableFullTree() {
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    /// The window that matches the captured CGWindow (by frame), or the app's focused window.
    func window() -> AXUIElement? {
        let windows = (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        if let windowID, let bounds = Self.bounds(of: windowID) {
            let sameFrame = windows.filter { frame(of: $0).map { Self.close($0, bounds) } ?? false }
            // Stacked windows can share a frame: the title tells them apart.
            let title = Self.title(of: windowID)
            if let match = sameFrame.first(where: { (attribute($0, kAXTitleAttribute) as? String) == title }) ?? sameFrame.first { return match }
            if let match = windows.first(where: { title != nil && (attribute($0, kAXTitleAttribute) as? String) == title }) { return match }
        }
        if let focused = attribute(app, kAXFocusedWindowAttribute) { return (focused as! AXUIElement) }
        return windows.first
    }

    /// On-screen popup menus of the app near its window (the window server's pop-up menu level).
    static func openMenus(pid: pid_t, near window: CGRect) -> [CGRect] {
        let level = Int(CGWindowLevelForKey(.popUpMenuWindow))
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
        return windows.compactMap { info in
            guard (info[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid, info[kCGWindowLayer as String] as? Int == level,
                  let raw = info[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: raw),
                  rect.width > 20, rect.height > 20, rect.intersects(window.insetBy(dx: -400, dy: -400)) else { return nil }
            return rect
        }
    }

    static func bounds(of windowID: CGWindowID) -> CGRect? {
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]],
              let raw = info.first?[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: raw) else { return nil }
        return rect
    }
    static func title(of windowID: CGWindowID) -> String? {
        (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first?[kCGWindowName as String] as? String
    }
    private static func close(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) < 3 && abs(a.minY - b.minY) < 3 && abs(a.width - b.width) < 3 && abs(a.height - b.height) < 3
    }

    func read(includeMenuBar: Bool = true) -> OutlineSnapshot? {
        let started = Date()
        guard let window = window(), let windowFrame = frame(of: window) else { return nil }
        document = (attribute(window, kAXTitleAttribute) as? String).flatMap(Self.document(inTitle:))
        var lines: [String] = []
        var texts: [String] = []
        var textLength = 0
        var targets: [String: OutlineTarget] = [:]
        var scrollAreas: [[String: Any]] = []
        var identity: [CGRect] = []
        var squashed: [CGRect] = [], containers: [CGRect] = []
        var web = false
        var visited = 0, index = 0
        let windowArea = max(1, windowFrame.width * windowFrame.height)

        func note(_ value: String) {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, textLength < textLimit, texts.last != trimmed else { return }
            texts.append(trimmed); textLength += trimmed.count + 1
        }

        /// `holder`: the small control this element sits in (an account button holds the name and the picture).
        func walk(_ element: AXUIElement, depth: Int, scope: String?, clip: CGRect, holder: CGRect?) {
            guard visited < nodeLimit, depth < 60 else { return }
            visited += 1
            let values = attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                              kAXValueAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute,
                                              kAXExpandedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXPlaceholderValueAttribute,
                                              kAXHelpAttribute, kAXChildrenAttribute])
            let role = values[kAXRoleAttribute] as? String ?? ""
            let subrole = values[kAXSubroleAttribute] as? String ?? ""
            let frame = Self.rect(values[kAXPositionAttribute], values[kAXSizeAttribute])
            let secure = subrole == kAXSecureTextFieldSubrole as String
            var childScope = scope
            var childClip = clip

            if role == kAXStaticTextRole as String, let text = values[kAXValueAttribute] as? String { note(text) }
            var childHolder = holder
            if let frame, Self.map(role: role, subrole: subrole, actions: []) != nil || role == kAXButtonRole as String {
                // Only a compact control (an account button, an avatar chip) is covered whole; a row or a panel is not.
                childHolder = frame.width <= windowFrame.width * 0.3 && frame.height <= windowFrame.height * 0.1 ? frame : nil
            }
            if let frame, let covered = identityBox(element, values: values, role: role, frame: frame, holder: childHolder) {
                let clipped = covered.intersection(windowFrame)
                if !clipped.isNull, clipped.width >= 2, clipped.height >= 2 {
                    identity.append(clipped.offsetBy(dx: -windowFrame.minX, dy: -windowFrame.minY))
                }
            }
            if role == "AXWebArea" { web = true }
            if let frame {
                if frame.height <= 2, frame.width >= 8 { squashed.append(frame) }
                if frame.width > 200, frame.height > max(120, windowFrame.height * 0.25), [kAXGroupRole as String, kAXTextAreaRole as String, kAXListRole as String, "AXWebArea"].contains(role) { containers.append(frame) }
            }
            if role == kAXScrollAreaRole as String, let frame, frame.width > 40, frame.height > 40 {
                childClip = clip.intersection(frame)
                if let area = scrollArea(element, frame: frame, window: windowFrame) { scrollAreas.append(area) }
            }
            if [kAXRowRole as String, kAXCellRole as String].contains(role), let summary = rowSummary(element, values: values) {
                childScope = summary
            } else if [kAXGroupRole as String, "AXTabGroup", "AXSplitGroup", "AXToolbar"].contains(role),
                      let label = (values[kAXTitleAttribute] as? String) ?? (values[kAXDescriptionAttribute] as? String), !label.isEmpty {
                childScope = label
            }
            // Window chrome is never a target: Jev must not close, minimize or resize the recorded window.
            if ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"].contains(subrole) { return }
            if let mapped = Self.map(role: role, subrole: subrole, actions: actionNames(element)), let frame, frame.width >= 2, frame.height >= 2 {
                let name = self.name(element, values: values, role: role)
                index += 1
                let ref = "ref_\(index)"
                var states: [String] = []
                if (values[kAXEnabledAttribute] as? Bool) == false { states.append("disabled") }
                if (values[kAXFocusedAttribute] as? Bool) == true { states.append("focused") }
                if (values[kAXSelectedAttribute] as? Bool) == true { states.append("selected") }
                if let expanded = values[kAXExpandedAttribute] as? Bool { states.append(expanded ? "expanded" : "collapsed") }
                if ["checkbox", "radio", "switch"].contains(mapped), let on = values[kAXValueAttribute] as? Int { states.append(on == 1 ? "checked" : "unchecked") }
                if secure { states.append("secure") }
                // A text field with selected text says so, so a "select it" step reads as already done.
                if !secure, ["textbox", "searchbox"].contains(mapped), let selected = attribute(element, kAXSelectedTextAttribute) as? String,
                   !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    states.append("selected")
                    note("Selected text: \(selected.prefix(200))")
                }
                var line = "  [\(ref)] \(mapped)"
                if !name.isEmpty { line += " " + Self.json(String(name.prefix(200))) }
                line += states.map { " " + $0 }.joined()
                if !secure, ["textbox", "searchbox", "combobox", "slider"].contains(mapped), let value = Self.string(values[kAXValueAttribute]), !value.isEmpty {
                    line += " value=" + Self.json(String(value.prefix(120)))
                }
                if mapped == "combobox", role == kAXPopUpButtonRole as String {
                    let options = popupOptions(element)
                    if !options.isEmpty { line += " options=" + Self.jsonArray(options) }
                }
                if let scope, scope != name { line += " in " + Self.json(String(scope.prefix(120))) }
                line += " — " + location(frame, window: windowFrame, clip: clip)
                lines.append(line)
                targets[ref] = OutlineTarget(element: element, frame: frame, role: mapped, secure: secure, label: name.isEmpty ? mapped : "\(mapped) \(Self.json(String(name.prefix(80))))")
                if role != kAXStaticTextRole as String, !name.isEmpty, mapped != "menuitem" { note(name) }
            }
            // A popup's menu is already summarized in options=[…]; its items are not separate targets.
            if role == kAXPopUpButtonRole as String { return }
            guard let children = values[kAXChildrenAttribute] as? [AXUIElement] else { return }
            for child in children { walk(child, depth: depth + 1, scope: childScope, clip: childClip, holder: childHolder) }
        }

        walk(window, depth: 0, scope: nil, clip: windowFrame, holder: nil)
        // A menu the app has open (a toolbar's popup, a context menu) is a window of its own above the shared one, and
        // can reach past its edge (Books' "Seções"): its items are read too, so picking one is a choice the navigator sees.
        for popup in Self.openMenus(pid: pid, near: windowFrame)
        where !targets.values.contains(where: { $0.role == "menuitem" && popup.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }) {
            var hit: AXUIElement?
            AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(popup.midX), Float(popup.minY + min(40, popup.height / 2)), &hit)
            var node = hit
            while let current = node, (attribute(current, kAXRoleAttribute) as? String) != kAXMenuRole as String {
                node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
            }
            var owner: pid_t = 0
            guard let menu = node, AXUIElementGetPid(menu, &owner) == .success, owner == pid else { continue }
            walk(menu, depth: 0, scope: "open menu", clip: popup, holder: nil)
        }
        if includeMenuBar, let bar = attribute(app, kAXMenuBarAttribute) {
            // Top-level menus only: opening one is an action, and its items are read after it opens.
            for item in ((attribute(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement]) ?? []).dropFirst() {
                let values = attributes(item, [kAXTitleAttribute, kAXPositionAttribute, kAXSizeAttribute])
                guard let title = values[kAXTitleAttribute] as? String, !title.isEmpty, let frame = Self.rect(values[kAXPositionAttribute], values[kAXSizeAttribute]) else { continue }
                index += 1
                let ref = "ref_\(index)"
                lines.append("  [\(ref)] menubaritem \(Self.json(title)) in \"menu bar\" — visible at (\(Int(frame.midX - windowFrame.minX)),\(Int(frame.midY - windowFrame.minY))) menu bar")
                targets[ref] = OutlineTarget(element: item, frame: frame, role: "menubaritem", secure: false, label: "menubaritem \(Self.json(title))")
            }
        }
        scrollAreas += Self.clippedRegions(squashed: squashed, containers: containers, window: windowFrame)
        let header = "Scroll areas (layout only; offscreen content is not visual proof): " + Self.jsonObject(["regions": scrollAreas])
        return OutlineSnapshot(outline: ([header] + lines).joined(separator: "\n"), text: texts.joined(separator: "\n"),
                               window: windowFrame, targets: targets, elements: index, milliseconds: Int(Date().timeIntervalSince(started) * 1000),
                               identity: identity, web: web)
    }

    /// The Mac user's full name, when it is specific enough to find without blurring ordinary words.
    static let identityName: String? = {
        let name = NSFullUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        return name.split(separator: " ").count >= 2 && name.count >= 5 ? name : nil
    }()
    /// An element that shows the user's own name, the one thing about them an app puts on screen unasked.
    static func showsIdentity(_ values: [String: Any]) -> Bool {
        guard let name = identityName else { return false }
        for key in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
            if let text = values[key] as? String, text.range(of: name, options: [.caseInsensitive, .diacriticInsensitive]) != nil { return true }
        }
        return false
    }
    /// A label that is the name, or little more ("Ana Silva", "Assigned to Ana Silva"); a row's whole
    /// summary that happens to mention the assignee is not, and is left to the text inside it.
    static func namesIdentity(_ text: String) -> Bool {
        guard let name = identityName else { return false }
        return text.count <= name.count + 24 && text.range(of: name, options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }

    /// Where an element shows the user's name: the letters themselves, from the text's own layout. Pictures and the
    /// controls holding them are left alone (an initials avatar says nothing, and a blurred chip only draws the eye).
    private func identityBox(_ element: AXUIElement, values: [String: Any], role: String, frame: CGRect, holder: CGRect?) -> CGRect? {
        guard let name = Self.identityName else { return nil }
        if role != kAXStaticTextRole as String {
            // A control whose label is the name (Books' account button, name and photo together) is covered whole;
            // a bare picture labelled with it (an initials avatar) is not.
            guard role != kAXImageRole as String,
                  [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].compactMap({ values[$0] as? String }).contains(where: Self.namesIdentity),
                  frame.width <= 600, frame.height <= 120 else { return nil }
            return frame
        }
        guard let text = values[kAXValueAttribute] as? String,
              let found = text.range(of: name, options: [.caseInsensitive, .diacriticInsensitive]) else { return nil }
        var range = CFRange(location: text.utf16.distance(from: text.utf16.startIndex, to: found.lowerBound.samePosition(in: text.utf16) ?? text.utf16.startIndex),
                            length: text[found].utf16.count)
        var bounds: AnyObject?
        if let parameter = AXValueCreate(.cfRange, &range),
           AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute as CFString, parameter, &bounds) == .success,
           let value = bounds, CFGetTypeID(value) == AXValueGetTypeID() {
            var rect = CGRect.zero
            if AXValueGetValue(value as! AXValue, .cgRect, &rect), rect.width >= 2, rect.height >= 2 { return rect.insetBy(dx: -3, dy: -2) }
        }
        // No layout for the range: only a label that is just the name is covered whole.
        return Self.namesIdentity(text) && frame.width <= 600 && frame.height <= 120 ? frame : nil
    }

    // MARK: roles and names

    static func map(role: String, subrole: String, actions: [String]) -> String? {
        switch role {
        case kAXButtonRole as String, "AXMenuButton": return subrole == "AXTabButton" ? "tab" : "button"
        case kAXPopUpButtonRole as String, kAXComboBoxRole as String: return "combobox"
        case kAXTextFieldRole as String: return subrole == kAXSearchFieldSubrole as String ? "searchbox" : "textbox"
        case kAXTextAreaRole as String: return "textbox"
        case kAXCheckBoxRole as String: return subrole == kAXSwitchSubrole as String ? "switch" : "checkbox"
        case kAXRadioButtonRole as String: return subrole == "AXTabButton" ? "tab" : "radio"
        case "AXLink": return "link"
        case kAXMenuItemRole as String: return "menuitem"
        case kAXSliderRole as String: return "slider"
        case kAXDisclosureTriangleRole as String: return "button"
        case kAXRowRole as String where actions.contains(kAXPressAction as String) || subrole == kAXOutlineRowSubrole as String: return "row"
        case kAXRowRole as String: return "row"
        case kAXCellRole as String where actions.contains(kAXPressAction as String): return "cell"
        case kAXStaticTextRole as String, kAXImageRole as String, kAXGroupRole as String:
            return actions.contains(kAXPressAction as String) ? "button" : nil
        default:
            return actions.contains(kAXPressAction as String) ? "button" : nil
        }
    }

    private func name(_ element: AXUIElement, values: [String: Any], role: String) -> String {
        for key in [kAXTitleAttribute, kAXDescriptionAttribute] {
            if let value = values[key] as? String, !value.isEmpty {
                if [kAXTextAreaRole as String, kAXTextFieldRole as String].contains(role), Self.isEditorHint(value) {
                    return document.map { "\($0) editor" } ?? "code editor"
                }
                return Self.displayName(value)
            }
        }
        if let label = attribute(element, kAXTitleUIElementAttribute), let text = attribute(label as! AXUIElement, kAXValueAttribute) as? String, !text.isEmpty { return text }
        if let placeholder = values[kAXPlaceholderValueAttribute] as? String, !placeholder.isEmpty { return placeholder }
        if role == kAXRowRole as String || role == kAXCellRole as String, let summary = rowSummary(element, values: values) { return summary }
        // Web menus and buttons often carry their label only as text inside them (Linear's status menu items):
        // name them by that text, so "In Progress" is something the navigator can choose.
        if [kAXMenuItemRole as String, kAXButtonRole as String, "AXLink", kAXRadioButtonRole as String, kAXCheckBoxRole as String].contains(role),
           let inner = rowSummary(element, values: values) { return inner }
        if role == kAXStaticTextRole as String, let text = values[kAXValueAttribute] as? String { return text }
        if let help = values[kAXHelpAttribute] as? String, !help.isEmpty { return help }
        if [kAXTextAreaRole as String, kAXTextFieldRole as String].contains(role), let description = attribute(element, kAXRoleDescriptionAttribute) as? String { return description }
        return ""
    }

    /// Editors (VS Code, Cursor) label explorer items with the file's absolute path; the screen shows only its name,
    /// and that is what a plan says ("open README.md"). A label that is a bare absolute path becomes its last part.
    /// Code editors (Monaco in VS Code and Cursor) label their text area with a screen-reader hint instead of a name:
    /// "The editor is not accessible at this time…". A plan says "type in the README.md editor", so it is named that.
    static func isEditorHint(_ label: String) -> Bool {
        label.hasPrefix("The editor is not accessible") || label.hasPrefix("Editor content")
    }

    /// "README.md — toru-skills" → "README.md"; a title without a document part names none.
    static func document(inTitle title: String) -> String? {
        let parts = title.components(separatedBy: " — ")
        guard parts.count >= 2, let first = parts.first?.trimmingCharacters(in: .whitespaces), !first.isEmpty else { return nil }
        return first.hasPrefix("● ") ? String(first.dropFirst(2)) : first
    }

    static func displayName(_ label: String) -> String {
        guard label.hasPrefix("/"), !label.contains("\n"), label.split(separator: "/").count >= 2,
              let last = label.split(separator: "/").last, !last.isEmpty else { return label }
        return String(last)
    }

    /// The visible text of a row or cell, so "which row" has an answer.
    private func rowSummary(_ element: AXUIElement, values: [String: Any]) -> String? {
        var parts: [String] = []
        var seen = 0
        func collect(_ node: AXUIElement, depth: Int) {
            guard seen < 40, depth < 6, parts.joined(separator: " ").count < 120 else { return }
            seen += 1
            let v = attributes(node, [kAXRoleAttribute, kAXValueAttribute, kAXTitleAttribute, kAXChildrenAttribute])
            if (v[kAXRoleAttribute] as? String) == kAXStaticTextRole as String, let text = v[kAXValueAttribute] as? String, !text.isEmpty { parts.append(text) }
            else if let title = v[kAXTitleAttribute] as? String, !title.isEmpty, depth > 0 { parts.append(title) }
            for child in (v[kAXChildrenAttribute] as? [AXUIElement]) ?? [] { collect(child, depth: depth + 1) }
        }
        collect(element, depth: 0)
        let summary = parts.joined(separator: " · ").trimmingCharacters(in: .whitespacesAndNewlines)
        return summary.isEmpty ? nil : String(summary.prefix(120))
    }

    private func popupOptions(_ element: AXUIElement) -> [String] {
        guard let menu = (attribute(element, kAXChildrenAttribute) as? [AXUIElement])?.first(where: { (attribute($0, kAXRoleAttribute) as? String) == kAXMenuRole as String }) else { return [] }
        return ((attribute(menu, kAXChildrenAttribute) as? [AXUIElement]) ?? []).compactMap { attribute($0, kAXTitleAttribute) as? String }.filter { !$0.isEmpty }.prefix(25).map { String($0.prefix(60)) }
    }

    // MARK: geometry

    private func location(_ frame: CGRect, window: CGRect, clip: CGRect) -> String {
        let visible = frame.intersection(clip)
        if visible.isNull || visible.width < 2 || visible.height < 2 {
            var hidden: [String] = []
            if frame.maxY <= clip.minY { hidden.append("above") }
            if frame.minY >= clip.maxY { hidden.append("below") }
            if frame.maxX <= clip.minX { hidden.append("left") }
            if frame.minX >= clip.maxX { hidden.append("right") }
            return "offscreen-" + (hidden.isEmpty ? "clipped" : hidden.joined(separator: "-")) + " (scroll to reveal)"
        }
        let x = Int((visible.midX - window.minX).rounded()), y = Int((visible.midY - window.minY).rounded())
        return "visible at (\(x),\(y)) window points"
    }

    private func scrollArea(_ element: AXUIElement, frame: CGRect, window: CGRect) -> [String: Any]? {
        func remaining(_ bar: String) -> (Double, Double) {
            guard let scrollBar = attribute(element, bar), let value = attribute(scrollBar as! AXUIElement, kAXValueAttribute) as? Double else { return (0, 0) }
            let contents = (attribute(element, kAXContentsAttribute) as? [AXUIElement])?.first.flatMap { self.frame(of: $0) }
            let overflow = bar == kAXVerticalScrollBarAttribute as String ? max(0, (contents?.height ?? frame.height) - frame.height) : max(0, (contents?.width ?? frame.width) - frame.width)
            return ((value * overflow).rounded(), ((1 - value) * overflow).rounded())
        }
        let (up, down) = remaining(kAXVerticalScrollBarAttribute as String)
        let (left, right) = remaining(kAXHorizontalScrollBarAttribute as String)
        guard up + down + left + right > 0 else { return nil }
        let isPage = frame.width * frame.height > window.width * window.height * 0.5
        return ["kind": isPage ? "page" : "panel", "wheelAt": ["x": Int(frame.midX - window.minX), "y": Int(frame.midY - window.minY)],
                "remainingPixels": ["up": up, "down": down, "left": left, "right": right]]
    }

    /// Web content (Chromium, Electron) has no scroll area role: a scrolled container reports the content past its edge
    /// squashed to a sliver on that edge (Cursor's markdown preview puts every paragraph below the fold at its bottom).
    /// Two or more slivers on a container's edge mean there is more to scroll that way; the smallest such container is the
    /// one to scroll. Distances are estimated from the slivers (about one line each).
    static func clippedRegions(squashed: [CGRect], containers: [CGRect], window: CGRect) -> [[String: Any]] {
        var regions: [[String: Any]] = []
        var claimed = Set<Int>()
        for container in containers.sorted(by: { $0.width * $0.height < $1.width * $1.height }) {
            func onEdge(_ edge: CGFloat) -> [Int] {
                squashed.indices.filter { !claimed.contains($0) && abs(squashed[$0].midY - edge) <= 2
                    && squashed[$0].minX >= container.minX - 2 && squashed[$0].maxX <= container.maxX + 2 }
            }
            let below = onEdge(container.maxY - 1), above = onEdge(container.minY + 1)
            let down = below.count >= 2 ? below : [], up = above.count >= 2 ? above : []
            guard !down.isEmpty || !up.isEmpty else { continue }
            claimed.formUnion(down + up)
            let isPage = container.width * container.height > window.width * window.height * 0.5
            regions.append(["kind": isPage ? "page" : "panel",
                            "wheelAt": ["x": Int(container.midX - window.minX), "y": Int(container.midY - window.minY)],
                            "remainingPixels": ["up": Double(up.count * 30), "down": Double(down.count * 30), "left": 0.0, "right": 0.0]])
        }
        return regions
    }

    func frame(of element: AXUIElement) -> CGRect? {
        let values = attributes(element, [kAXPositionAttribute, kAXSizeAttribute])
        return Self.rect(values[kAXPositionAttribute], values[kAXSizeAttribute])
    }

    static func rect(_ position: Any?, _ size: Any?) -> CGRect? {
        guard let position, let size else { return nil }
        var point = CGPoint.zero, extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
        return CGRect(origin: point, size: extent)
    }

    // MARK: attribute access

    func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func attributes(_ element: AXUIElement, _ names: [String]) -> [String: Any] {
        var raw: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
              let values = raw as? [AnyObject] else { return [:] }
        var out: [String: Any] = [:]
        for (key, value) in zip(names, values) {
            // Missing attributes come back as AXValue errors, not nil.
            if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { continue }
            out[key] = value
        }
        return out
    }
    private func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        return AXUIElementCopyActionNames(element, &names) == .success ? (names as? [String]) ?? [] : []
    }

    // MARK: JSON helpers

    static func string(_ value: Any?) -> String? {
        if let text = value as? String { return text }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }
    static func json(_ text: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [text], options: [.withoutEscapingSlashes])
        let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }
    static func jsonArray(_ items: [String]) -> String {
        let data = try? JSONSerialization.data(withJSONObject: items, options: [.withoutEscapingSlashes])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }
    static func jsonObject(_ object: [String: Any]) -> String {
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes, .sortedKeys])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}
