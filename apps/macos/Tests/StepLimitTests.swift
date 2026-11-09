import Foundation

/// swiftc -parse-as-library Sources/StepLimit.swift Tests/StepLimitTests.swift -o /tmp/toru-step-tests && /tmp/toru-step-tests
@main struct StepLimitTests {
    struct Refused: Error {}

    static func main() async {
        // A step that finishes in time gives its result.
        let quick = try? await StepLimit.run(seconds: 2) { 42 }
        precondition(quick == 42)
        // Its own error comes back as it was thrown.
        do { _ = try await StepLimit.run(seconds: 2) { () throws -> Int in throw Refused() }; preconditionFailure("no error") }
        catch { precondition(error is Refused) }
        // A step that never answers is reported after the limit, not when it ends, with the code the server forwards.
        let started = Date()
        do {
            _ = try await StepLimit.run(seconds: 0.3) { () -> Int in Thread.sleep(forTimeInterval: 3); return 1 }
            preconditionFailure("no timeout")
        } catch let exceeded as StepLimit.Exceeded {
            let waited = Date().timeIntervalSince(started)
            precondition(waited >= 0.3 && waited < 1.5, "answered after \(waited)s")
            precondition(exceeded.localizedDescription.hasPrefix("local_action_timeout"))
        } catch { preconditionFailure("unexpected \(error)") }
        print("StepLimitTests passed")
    }
}
