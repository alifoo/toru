import Foundation
import ScreenCaptureKit

/// Pure decisions for recording edge cases. Any violation stops the capture and keeps the local file;
/// the app never switches to another source on its own and always asks for fresh consent afterwards.
enum SourcePresence: Equatable { case present, windowClosed, windowHidden, displayDisconnected }

struct CaptureGuards {
    static let minimumStartBytes: Int64 = 500 * 1024 * 1024
    static let minimumRecordingBytes: Int64 = 150 * 1024 * 1024
    static let watchInterval: Duration = .seconds(3)

    static func freeBytes(at url: URL) -> Int64? {
        (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
    }
    static func startBlocked(freeBytes: Int64?) -> String? {
        guard let freeBytes else { return "Could not check free disk space for Movies/Toru." }
        return freeBytes < minimumStartBytes ? "Not enough free disk space to record safely (need 500 MB in Movies/Toru)." : nil
    }
    static func recordingBlocked(freeBytes: Int64?) -> String? {
        guard let freeBytes, freeBytes < minimumRecordingBytes else { return nil }
        return "Disk almost full. Recording stopped and the local capture was saved."
    }
    static func presence(windowIDs: [CGWindowID], displayIDs: [CGDirectDisplayID],
                         windows: [(id: CGWindowID, onScreen: Bool)], displays: [CGDirectDisplayID]) -> SourcePresence {
        for id in displayIDs where !displays.contains(id) { return .displayDisconnected }
        for id in windowIDs {
            guard let window = windows.first(where: { $0.id == id }) else { return .windowClosed }
            if !window.onScreen { return .windowHidden }
        }
        return .present
    }
    static func message(for presence: SourcePresence) -> String? {
        switch presence {
        case .present: return nil
        case .windowClosed: return "The recorded window closed. Recording stopped; the local capture was saved. Choose a source and approve a new recording."
        case .windowHidden: return "The recorded window was minimized or hidden. Recording stopped; the local capture was saved. Approve a new recording when it is visible."
        case .displayDisconnected: return "The recorded display was disconnected. Recording stopped; the local capture was saved."
        }
    }
    /// User-facing text for ScreenCaptureKit failures. Raw framework text is kept for unknown cases.
    static func describe(_ error: Error) -> String {
        let nsError = error as NSError
        guard nsError.domain == SCStreamErrorDomain, let code = SCStreamError.Code(rawValue: nsError.code) else { return error.localizedDescription }
        switch code {
        case .userDeclined, .missingEntitlements:
            return "Screen Recording permission was denied or revoked. Allow Toru in System Settings → Privacy & Security → Screen & System Audio Recording, then approve a new recording."
        case .noCaptureSource, .noWindowList, .noDisplayList, .failedNoMatchingApplicationContext:
            return "The selected source is no longer available. Recording stopped; any saved capture remains in Movies/Toru."
        case .userStopped, .systemStoppedStream:
            return "macOS stopped the capture. Recording stopped; the local capture was saved. Approve a new recording to continue."
        case .failedToStart:
            return "Recording did not start. Check Screen Recording permission and that the source is visible."
        default:
            return "Capture failed (\(nsError.code)). Any saved video remains in Movies/Toru."
        }
    }
    /// Backend error codes from the local-browser bridge become actionable messages.
    static func describe(serverCode: String?, status: Int) -> String {
        switch serverCode {
        case "device_credentials_expired": return "This Mac's credential expired or was revoked. Pair again with a new code from your agent; local videos are preserved."
        case "local_browser_disconnected": return "The recording session expired or was ended by your agent. Approve a new recording to continue; local videos are preserved."
        case "recording_in_progress": return "This Mac is still recording in another session. Stop it first."
        case "desktop_capture_consent_required": return "Approve recording and upload in Toru before sharing."
        case "pairing_code_invalid": return "That pairing code is invalid or expired. Ask your agent for a new one."
        case "app_update_required": return "This version of Toru is too old for the server. Update Toru from toru.tools/mac, then share again. Local videos are preserved."
        case "desktop_sessions_disabled": return "Mac recording is temporarily disabled on this server. Existing uploads still work; try again later."
        default: return status == 0 ? "Connection unavailable. Try sharing again; your local files are preserved." : "Server refused the request (\(status)). Try sharing again; your local files are preserved."
        }
    }
}
