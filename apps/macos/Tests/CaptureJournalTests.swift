import Foundation

@main struct CaptureJournalTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("toru-journal-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let journal = CaptureJournal(directory: root)
        let initial = try journal.load()
        precondition(initial.isEmpty)
        let states: [LocalCapture.Stage] = [.recording, .finalizing, .saved, .uploading, .uploaded]
        let entries = states.map { LocalCapture(id: UUID(), createdAt: Date(), stage: $0, durationMs: 1200, width: 1280, height: 720) }
        for entry in entries { try journal.save(entry) }
        // A broken manifest must not make other recoverable recordings disappear.
        try Data("broken".utf8).write(to: root.appendingPathComponent("\(UUID()).json"))
        let recovered = try CaptureJournal(directory: root).recover()
        precondition(recovered.count == 5)
        for original in entries {
            let actual = recovered.first { $0.id == original.id }!
            let expected: LocalCapture.Stage = original.stage == .uploading ? .saved : [.recording, .finalizing].contains(original.stage) ? .interrupted : original.stage
            precondition(actual.stage == expected)
            precondition(actual.durationMs == 1200)
            precondition(journal.file(for: actual).deletingLastPathComponent().path == root.path)
        }
        let old = Date(timeIntervalSinceNow: -40 * 24 * 3600)
        let aged: [LocalCapture] = [
            LocalCapture(id: UUID(), createdAt: old, stage: .uploaded, durationMs: 1, width: 2, height: 2),
            LocalCapture(id: UUID(), createdAt: old, stage: .saved, durationMs: 1, width: 2, height: 2),
            LocalCapture(id: UUID(), createdAt: old, stage: .interrupted, durationMs: nil, width: 2, height: 2),
            LocalCapture(id: UUID(), createdAt: Date(), stage: .uploaded, durationMs: 1, width: 2, height: 2),
        ]
        let expired = CaptureJournal.expired(aged)
        precondition(expired.map(\.id) == [aged[0].id], "only old uploaded copies expire; saved/interrupted files and recent uploads are kept")
        let second = try CaptureJournal(directory: root).recover()
        precondition(second.map(\.stage) == recovered.map(\.stage))
        let attributes = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("\(entries[0].id.uuidString).json").path)
        precondition((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let bound = LocalCapture(id: UUID(), createdAt: Date(), stage: .uploading, durationMs: 15000, width: 1280, height: 720,
                                 serverOrigin: "https://mcp.toru.tools", deviceId: "original-device")
        try journal.save(bound)
        let retry = try journal.recover().first { $0.id == bound.id }!
        precondition(retry.canRetry(server: "https://mcp.toru.tools", device: "original-device"))
        precondition(!retry.canRetry(server: "https://other.example", device: "original-device"))
        precondition(!retry.canRetry(server: "https://mcp.toru.tools", device: "other-device"))
        precondition(!entries[2].canRetry(server: "https://mcp.toru.tools", device: "original-device"))
        precondition(retry.durationMs == bound.durationMs && retry.width == bound.width && retry.height == bound.height)
        print("PASS: restart recovery, interrupted encoder classification, upload preservation, corrupt manifest isolation, atomic persistence and private permissions")
    }
}
