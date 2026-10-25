import Foundation

/// Executed by scripts/smoke-macos-recovery.mjs against a disposable local backend.
@main struct CaptureRetryTests {
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        let server = args[args.firstIndex(of: "--server")! + 1]
        let root = URL(fileURLWithPath: args[args.firstIndex(of: "--fixture")! + 1])
        let identity = try JSONDecoder().decode(DeviceIdentity.self, from: Data(contentsOf: root.appendingPathComponent("identity.json")))
        try DeviceKeychain.save(identity, server: server)
        defer { try? DeviceKeychain.remove(server: server) }
        let journal = CaptureJournal(directory: root.appendingPathComponent("captures"))
        let before = try journal.load().first!
        precondition(before.stage == .uploading)
        let studio = Studio(journal: journal)
        let capture = studio.recent.first!
        precondition(capture.stage == .saved && studio.canRetry(capture))
        studio.retryUpload(capture)
        for _ in 0..<600 {
            if !studio.busy { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        precondition(!studio.busy, "Retry did not finish")
        precondition(studio.recent.first?.stage == .uploaded, studio.status)
        precondition(!studio.recording && !studio.connected && !studio.consent)
        precondition(studio.capture.stream == nil)
        precondition(FileManager.default.fileExists(atPath: journal.file(for: capture).path))
        let relaunched = Studio(journal: journal)
        precondition(relaunched.recent.first?.stage == .uploaded)
        precondition(!relaunched.canRetry(relaunched.recent.first!))
        print("PASS: Swift relaunch → retry HTTP upload → publication, no capture consent or stream, local file preserved")
    }
}
