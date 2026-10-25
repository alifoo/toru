import CoreGraphics

/// The window sizes an agent can ask a recording to use, in points (`windowSize` on the desktop recording tools), and
/// how one is fitted to the screen. Pure: the Accessibility calls that apply it are in WindowResize.
enum WindowSizing {
    static let presets: [String: CGSize] = [
        "1280x720": CGSize(width: 1280, height: 720),
        "1440x900": CGSize(width: 1440, height: 900),
        "1920x1080": CGSize(width: 1920, height: 1080),
    ]
    static let defaultPreset = "1920x1080"

    /// The preset when it fits the screen's visible frame; otherwise the largest size with its aspect ratio that does.
    static func fit(_ preset: CGSize, in visible: CGSize) -> CGSize {
        guard preset.width > 0, preset.height > 0, visible.width > 0, visible.height > 0 else { return preset }
        let scale = min(1, visible.width / preset.width, visible.height / preset.height)
        return CGSize(width: (preset.width * scale).rounded(.down), height: (preset.height * scale).rounded(.down))
    }

    /// Where a window of `size` goes: its current top-left corner when it fits there, otherwise moved just enough to
    /// lie inside the visible frame. Screen coordinates with the origin at the top left, as Accessibility uses.
    static func origin(for size: CGSize, from current: CGRect, in visible: CGRect) -> CGPoint {
        let x = min(max(current.minX, visible.minX), max(visible.minX, visible.maxX - size.width))
        let y = min(max(current.minY, visible.minY), max(visible.minY, visible.maxY - size.height))
        return CGPoint(x: x.rounded(), y: y.rounded())
    }

    /// Within a couple of points: apps round sizes to their own steps (a text grid, a toolbar).
    static func close(_ a: CGSize, _ b: CGSize, tolerance: CGFloat = 2) -> Bool {
        abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }

    /// What happened to the shared window, reported with the recording (capture metadata `desktopWindow`).
    struct Report: Equatable {
        enum Reason: String {
            /// The window was not changed: Let your agent operate the shared window is off, or Accessibility is.
            case controlOff = "control_off"
            /// A display is shared; displays are never resized.
            case display
            /// The window refused a new size (fixed-size windows) or is full screen.
            case notResizable = "not_resizable"
            /// The preset did not fit the screen; the largest size with its aspect ratio that fits was used.
            case fittedToScreen = "fitted_to_screen"
            /// The app kept the window at another size than asked (its own minimum or maximum).
            case appLimited = "app_limited"
        }
        var requested: String
        var width: Int
        var height: Int
        var resized: Bool
        var reason: Reason?
        var restored: Bool?

        var payload: [String: Any] {
            var value: [String: Any] = ["requested": requested, "width": width, "height": height, "resized": resized]
            if let reason { value["reason"] = reason.rawValue }
            if let restored { value["restored"] = restored }
            return value
        }
    }

    /// The report for a window after Toru tried to give it `target` (the fitted preset), from its size before and after.
    static func report(requested: String, preset: CGSize, target: CGSize, before: CGSize, after: CGSize) -> Report {
        let resized = !close(after, before)
        let reason: Report.Reason?
        if !resized && !close(after, target) { reason = .notResizable }
        else if !close(after, target) { reason = .appLimited }
        else if !close(target, preset) { reason = .fittedToScreen }
        else { reason = nil }
        return Report(requested: requested, width: Int(after.width.rounded()), height: Int(after.height.rounded()), resized: resized, reason: reason)
    }
}
