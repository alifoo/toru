import AppKit
import ApplicationServices

/// Gives the shared window a preset size for a recording, through Accessibility, and puts it back afterwards.
/// Used only when the user lets their agent operate the shared window; displays are never resized.
struct WindowResize: @unchecked Sendable {
    /// How the window was before Toru changed it.
    let element: AXUIElement
    let windowID: CGWindowID
    let original: CGRect

    /// Resizes the window with `windowID` to the preset (fitted to its screen's visible frame), keeping it on that
    /// screen. Returns what happened, and how to undo it when anything changed.
    /// Runs off the main thread (Accessibility calls block); `screens` comes from screenFrames() on the main thread.
    static func apply(preset name: String, windowID: CGWindowID, pid: pid_t, screens: [ScreenFrame]) -> (report: WindowSizing.Report, undo: WindowResize?) {
        let preset = WindowSizing.presets[name] ?? WindowSizing.presets[WindowSizing.defaultPreset]!
        let current = AccessibilityOutline.bounds(of: windowID) ?? .zero
        func unchanged(_ reason: WindowSizing.Report.Reason) -> (WindowSizing.Report, WindowResize?) {
            (WindowSizing.Report(requested: name, width: Int(current.width), height: Int(current.height), resized: false, reason: reason), nil)
        }
        let outline = AccessibilityOutline(pid: pid, windowID: windowID)
        guard let element = outline.window(), let before = AccessibilityOutline.bounds(of: windowID) ?? frame(of: element) else { return unchanged(.notResizable) }
        AXUIElementSetMessagingTimeout(element, 1.0)
        var settable: DarwinBoolean = false
        if (value(element, "AXFullScreen") as? Bool) == true
            || AXUIElementIsAttributeSettable(element, kAXSizeAttribute as CFString, &settable) != .success || !settable.boolValue {
            return unchanged(.notResizable)
        }
        // Off every screen (parked by a window manager, or on a disconnected display): leave it alone.
        guard let visible = visibleFrame(containing: before, screens: screens) else { return unchanged(.notResizable) }
        let target = WindowSizing.fit(preset, in: visible.size)
        if WindowSizing.close(before.size, target) {
            return (WindowSizing.report(requested: name, preset: preset, target: target, before: before.size, after: before.size), nil)
        }
        let origin = WindowSizing.origin(for: target, from: before, in: visible)
        let after = setFrame(element, windowID: windowID, CGRect(origin: origin, size: target)) ?? before
        let undo = WindowResize(element: element, windowID: windowID, original: before)
        let report = WindowSizing.report(requested: name, preset: preset, target: target, before: before.size, after: after.size)
        if !report.resized {
            // Refused (the size attribute said otherwise): leave the window where it was.
            _ = undo.restore()
            return (report, nil)
        }
        return (report, undo)
    }

    /// Puts the window back at its original size and position. True when it is back (or gone, nothing to restore).
    @discardableResult
    func restore() -> Bool {
        guard Self.frame(of: element) != nil else { return true }
        guard let now = Self.setFrame(element, windowID: windowID, original) else { return false }
        return WindowSizing.close(now.size, original.size) && abs(now.minX - original.minX) <= 2 && abs(now.minY - original.minY) <= 2
    }

    /// A screen's frame and visible frame (without menu bar and Dock), in top-left screen coordinates.
    struct ScreenFrame: Sendable { let frame: CGRect; let visible: CGRect }
    @MainActor static func screenFrames() -> [ScreenFrame] {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        func topLeft(_ rect: CGRect) -> CGRect { CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height) }
        return NSScreen.screens.map { ScreenFrame(frame: topLeft($0.frame), visible: topLeft($0.visibleFrame)) }
    }
    /// The visible frame of the screen holding most of `window`.
    private static func visibleFrame(containing window: CGRect, screens: [ScreenFrame]) -> CGRect? {
        func overlap(_ screen: ScreenFrame) -> CGFloat { let shared = screen.frame.intersection(window); return shared.isNull ? 0 : shared.width * shared.height }
        guard let best = screens.max(by: { overlap($0) < overlap($1) }), overlap(best) > 0 else { return nil }
        return best.visible
    }

    /// Shrinks what must shrink, moves, then grows, each time waiting for the app to apply it: a window is kept on its
    /// screen, so a size set before a move has landed is clamped at the screen edge, and a move that would push a
    /// large window past the edge is refused. Every step keeps the window inside the target rectangle or where it
    /// was. One more pass when an app (or a window manager) moved it meanwhile. Returns the frame it ends with.
    /// Progress is read from the window server (CGWindowList), not Accessibility: an Accessibility attribute shows a
    /// new value at once, before the app has moved the window, and the next step would race it.
    private static func setFrame(_ element: AXUIElement, windowID: CGWindowID, _ target: CGRect) -> CGRect? {
        func near(_ a: CGPoint, _ b: CGPoint) -> Bool { abs(a.x - b.x) <= 2 && abs(a.y - b.y) <= 2 }
        func done(_ frame: CGRect?) -> Bool { frame.map { near($0.origin, target.origin) && WindowSizing.close($0.size, target.size) } ?? false }
        func waitFor(_ done: (CGRect) -> Bool) -> CGRect? { Self.waitFor(windowID, until: done) }
        var now = AccessibilityOutline.bounds(of: windowID)
        for _ in 0..<2 {
            guard let current = now, !done(current) else { return now }
            let smaller = CGSize(width: min(current.width, target.width), height: min(current.height, target.height))
            if !WindowSizing.close(smaller, current.size) {
                set(element, kAXSizeAttribute, smaller)
                _ = waitFor { WindowSizing.close($0.size, smaller) }
            }
            set(element, kAXPositionAttribute, target.origin)
            _ = waitFor { near($0.origin, target.origin) }
            set(element, kAXSizeAttribute, target.size)
            now = waitFor { WindowSizing.close($0.size, target.size) }
            if let moved = now, !near(moved.origin, target.origin) {
                set(element, kAXPositionAttribute, target.origin)
                now = waitFor { near($0.origin, target.origin) }
            }
            if !done(now) { Thread.sleep(forTimeInterval: 0.25); now = AccessibilityOutline.bounds(of: windowID) }
        }
        return now
    }
    /// The window's frame once `done` holds for it, or as it is after ~1s (an app that refuses keeps its frame).
    private static func waitFor(_ windowID: CGWindowID, until done: (CGRect) -> Bool) -> CGRect? {
        var now = AccessibilityOutline.bounds(of: windowID)
        for _ in 0..<20 {
            if let current = now, done(current) { return current }
            Thread.sleep(forTimeInterval: 0.05)
            now = AccessibilityOutline.bounds(of: windowID)
        }
        return now
    }

    private static func value(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var result: AnyObject?
        return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
    }
    static func frame(of element: AXUIElement) -> CGRect? {
        var origin = CGPoint.zero, size = CGSize.zero
        guard let position = value(element, kAXPositionAttribute), let extent = value(element, kAXSizeAttribute),
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(extent) == AXValueGetTypeID(),
              AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(extent as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }
    private static func set(_ element: AXUIElement, _ attribute: String, _ point: CGPoint) {
        var point = point
        if let value = AXValueCreate(.cgPoint, &point) { AXUIElementSetAttributeValue(element, attribute as CFString, value) }
    }
    private static func set(_ element: AXUIElement, _ attribute: String, _ size: CGSize) {
        var size = size
        if let value = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(element, attribute as CFString, value) }
    }
}
