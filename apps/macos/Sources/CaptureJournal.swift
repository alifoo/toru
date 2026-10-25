import Foundation

struct LocalCapture: Codable, Identifiable {
    enum Stage: String, Codable {
        case recording, finalizing, saved, uploading, uploaded, interrupted
    }
    let id: UUID
    let createdAt: Date
    var stage: Stage
    var durationMs: Int?
    var width: Int
    var height: Int
    var serverOrigin: String?
    var deviceId: String?
    /// Where the window and its menus were inside the recording, for the render's background (see CaptureLayers).
    var layers: CaptureLayers?
    func canRetry(server: String, device: String?) -> Bool {
        stage == .saved && durationMs != nil && serverOrigin == server && deviceId != nil && deviceId == device
    }
    var fileName: String { "Toru-\(id.uuidString).mp4" }
}

/// Per-capture atomic manifests. No credentials or captured window titles on disk.
struct CaptureJournal {
    let directory: URL
    init(directory: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies/Toru", isDirectory: true)) {
        self.directory = directory
    }
    func file(for capture: LocalCapture) -> URL { directory.appendingPathComponent(capture.fileName) }
    func removeManifest(for capture: LocalCapture) throws {
        let url = directory.appendingPathComponent("\(capture.id.uuidString).json")
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
    func save(_ capture: LocalCapture) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent("\(capture.id.uuidString).json")
        try JSONEncoder().encode(capture).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func load() throws -> [LocalCapture] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .compactMap { url in
                // A damaged manifest must not hide other captures or delete any media.
                guard UUID(uuidString: url.deletingPathExtension().lastPathComponent) != nil,
                      let data = try? Data(contentsOf: url),
                      let capture = try? JSONDecoder().decode(LocalCapture.self, from: data),
                      url.deletingPathExtension().lastPathComponent == capture.id.uuidString else { return nil }
                return capture
            }.sorted { $0.createdAt > $1.createdAt }
    }
    static let uploadedRetention: TimeInterval = 30 * 24 * 3600
    /// Only copies already uploaded qualify for automatic cleanup; saved or interrupted files may be the sole copy.
    static func expired(_ captures: [LocalCapture], now: Date = Date(), retention: TimeInterval = uploadedRetention) -> [LocalCapture] {
        captures.filter { $0.stage == .uploaded && now.timeIntervalSince($0.createdAt) > retention }
    }
    func recover() throws -> [LocalCapture] {
        try load().map { original in
            var capture = original
            switch capture.stage {
            case .recording, .finalizing:
                capture.stage = .interrupted // A killed encoder may have left an invalid MP4.
            case .uploading:
                capture.stage = .saved // Never automatically repeat an upload after relaunch.
            default: break
            }
            if capture.stage != original.stage { try save(capture) }
            return capture
        }
    }
}
