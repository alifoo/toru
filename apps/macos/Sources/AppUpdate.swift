import Foundation

/// Pure update policy. Sparkle (when embedded) performs download/verification/install; this decides when and what to say.
enum UpdateDecision: Equatable { case none, available(String), required(String), deferred }

struct AppVersion: Comparable {
    let parts: [Int]
    init(_ text: String) {
        let numbers = text.split(separator: ".").map { Int($0) ?? -1 }
        parts = numbers.isEmpty || numbers.contains(-1) ? [0, 0, 0] : numbers + Array(repeating: 0, count: max(0, 3 - numbers.count))
    }
    static func < (a: AppVersion, b: AppVersion) -> Bool {
        for i in 0..<max(a.parts.count, b.parts.count) {
            let x = i < a.parts.count ? a.parts[i] : 0, y = i < b.parts.count ? b.parts[i] : 0
            if x != y { return x < y }
        }
        return false
    }
}

struct UpdatePolicy {
    static let checkInterval: TimeInterval = 24 * 3600
    /// Never interrupt a capture; a required update blocks new recordings but not stopping or uploading the current one.
    static func decision(current: String, latest: String?, minimum: String?, recording: Bool) -> UpdateDecision {
        if recording { return .deferred }
        let now = AppVersion(current)
        if let minimum, now < AppVersion(minimum) { return .required(latest ?? minimum) }
        if let latest, now < AppVersion(latest) { return .available(latest) }
        return .none
    }
    static func shouldCheck(lastCheck: Date?, now: Date = Date(), recording: Bool) -> Bool {
        guard !recording else { return false }
        guard let lastCheck else { return true }
        return now.timeIntervalSince(lastCheck) >= checkInterval
    }
    /// Reads the download manifest published at /downloads/mac.json; absent or malformed fields mean "no update known".
    static func latestVersion(fromManifest data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let latest = json["latest"] as? [String: Any], let version = latest["version"] as? String,
              version.range(of: #"^[0-9]+(\.[0-9]+){1,3}$"#, options: .regularExpression) != nil else { return nil }
        return version
    }
}
