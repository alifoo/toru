import CoreGraphics

/// swiftc -parse-as-library Sources/WindowSizing.swift Tests/WindowSizingTests.swift -o /tmp/toru-window-tests && /tmp/toru-window-tests
@main struct WindowSizingTests {
    static func main() {
        let preset = WindowSizing.presets["1920x1080"]!
        precondition(WindowSizing.presets.keys.sorted() == ["1280x720", "1440x900", "1920x1080"] && WindowSizing.defaultPreset == "1920x1080")
        // Fits: the preset itself.
        precondition(WindowSizing.fit(WindowSizing.presets["1280x720"]!, in: CGSize(width: 1512, height: 944)) == CGSize(width: 1280, height: 720))
        // Too large for a laptop screen: the largest 16:9 that fits its visible frame.
        precondition(WindowSizing.fit(preset, in: CGSize(width: 1512, height: 944)) == CGSize(width: 1512, height: 850))
        // A 1080p display less its menu bar: limited by height.
        precondition(WindowSizing.fit(preset, in: CGSize(width: 1920, height: 1055)) == CGSize(width: 1875, height: 1055))
        precondition(WindowSizing.fit(WindowSizing.presets["1440x900"]!, in: CGSize(width: 1280, height: 800)) == CGSize(width: 1280, height: 800))
        // Keeps the window's corner when it fits there; otherwise slides it inside the visible frame.
        let visible = CGRect(x: 0, y: 33, width: 1512, height: 944)
        precondition(WindowSizing.origin(for: CGSize(width: 800, height: 600), from: CGRect(x: 100, y: 80, width: 500, height: 400), in: visible) == CGPoint(x: 100, y: 80))
        precondition(WindowSizing.origin(for: CGSize(width: 1280, height: 720), from: CGRect(x: 600, y: 400, width: 500, height: 400), in: visible) == CGPoint(x: 232, y: 257))
        precondition(WindowSizing.origin(for: CGSize(width: 1512, height: 850), from: CGRect(x: -40, y: 10, width: 500, height: 400), in: visible) == CGPoint(x: 0, y: 33))
        // A second screen to the left (negative x) keeps its own coordinates.
        let left = CGRect(x: -1920, y: 0, width: 1920, height: 1055)
        precondition(WindowSizing.origin(for: CGSize(width: 1875, height: 1055), from: CGRect(x: -1500, y: 200, width: 900, height: 600), in: left) == CGPoint(x: -1875, y: 0))
        // Reports.
        let resized = WindowSizing.report(requested: "1920x1080", preset: preset, target: preset, before: CGSize(width: 900, height: 600), after: preset)
        precondition(resized == .init(requested: "1920x1080", width: 1920, height: 1080, resized: true, reason: nil))
        let fitted = WindowSizing.report(requested: "1920x1080", preset: preset, target: CGSize(width: 1512, height: 850), before: CGSize(width: 900, height: 600), after: CGSize(width: 1512, height: 850))
        precondition(fitted.reason == .fittedToScreen && fitted.resized)
        let refused = WindowSizing.report(requested: "1920x1080", preset: preset, target: preset, before: CGSize(width: 668, height: 500), after: CGSize(width: 668, height: 500))
        precondition(refused.reason == .notResizable && !refused.resized && refused.width == 668)
        let limited = WindowSizing.report(requested: "1280x720", preset: CGSize(width: 1280, height: 720), target: CGSize(width: 1280, height: 720), before: CGSize(width: 900, height: 600), after: CGSize(width: 1280, height: 760))
        precondition(limited.reason == .appLimited && limited.resized && limited.height == 760)
        // Already that size: nothing to change, nothing to report as a problem.
        let same = WindowSizing.report(requested: "1280x720", preset: CGSize(width: 1280, height: 720), target: CGSize(width: 1280, height: 720), before: CGSize(width: 1281, height: 720), after: CGSize(width: 1281, height: 720))
        precondition(!same.resized && same.reason == nil)
        var restored = resized; restored.restored = true
        precondition(restored.payload["restored"] as? Bool == true && restored.payload["reason"] == nil && restored.payload["width"] as? Int == 1920)
        precondition(refused.payload["reason"] as? String == "not_resizable")
        print("PASS: presets, fit to the visible frame, placement, resize reports")
    }
}
