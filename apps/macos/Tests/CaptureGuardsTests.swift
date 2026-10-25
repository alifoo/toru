import Foundation
import ScreenCaptureKit

@main struct CaptureGuardsTests {
    static func main() {
        let mib: Int64 = 1024 * 1024
        precondition(CaptureGuards.startBlocked(freeBytes: 499 * mib) != nil)
        precondition(CaptureGuards.startBlocked(freeBytes: 500 * mib) == nil)
        precondition(CaptureGuards.startBlocked(freeBytes: nil) != nil)
        precondition(CaptureGuards.recordingBlocked(freeBytes: 149 * mib) != nil)
        precondition(CaptureGuards.recordingBlocked(freeBytes: 150 * mib) == nil)
        precondition(CaptureGuards.recordingBlocked(freeBytes: nil) == nil, "unknown free space must not interrupt an active recording")

        let windows: [(id: CGWindowID, onScreen: Bool)] = [(10, true), (11, false)]
        precondition(CaptureGuards.presence(windowIDs: [10], displayIDs: [], windows: windows, displays: [1]) == .present)
        precondition(CaptureGuards.presence(windowIDs: [11], displayIDs: [], windows: windows, displays: [1]) == .windowHidden)
        precondition(CaptureGuards.presence(windowIDs: [12], displayIDs: [], windows: windows, displays: [1]) == .windowClosed)
        precondition(CaptureGuards.presence(windowIDs: [], displayIDs: [2], windows: windows, displays: [1]) == .displayDisconnected)
        precondition(CaptureGuards.presence(windowIDs: [], displayIDs: [], windows: [], displays: []) == .present, "sources without identity are not policed")
        precondition(CaptureGuards.message(for: .present) == nil)
        for state in [SourcePresence.windowClosed, .windowHidden, .displayDisconnected] {
            let text = CaptureGuards.message(for: state)!
            precondition(text.contains("stopped") && text.contains("saved"), "every stop explains that the local capture is kept")
        }

        let denied = NSError(domain: SCStreamErrorDomain, code: SCStreamError.Code.userDeclined.rawValue)
        precondition(CaptureGuards.describe(denied).contains("System Settings"))
        let gone = NSError(domain: SCStreamErrorDomain, code: SCStreamError.Code.noCaptureSource.rawValue)
        precondition(CaptureGuards.describe(gone).contains("no longer available"))
        let other = NSError(domain: "Other", code: 7, userInfo: [NSLocalizedDescriptionKey: "custom"])
        precondition(CaptureGuards.describe(other) == "custom")

        precondition(CaptureGuards.describe(serverCode: "device_credentials_expired", status: 401).contains("Pair again"))
        precondition(CaptureGuards.describe(serverCode: "local_browser_disconnected", status: 401).contains("Approve a new recording"))
        precondition(CaptureGuards.describe(serverCode: nil, status: 0).contains("Connection unavailable"))
        precondition(CaptureGuards.describe(serverCode: "unknown", status: 503).contains("503"))
        print("PASS: disk thresholds, source presence, ScreenCaptureKit and server error messages")
    }
}
