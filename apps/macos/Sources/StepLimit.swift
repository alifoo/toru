import Foundation

/// A control step that has not finished in time is answered as too slow instead of holding the agent's call open.
///
/// The server gives up on a Mac step after 45 s by dropping the whole share, and an agent's tool call that runs past the
/// server's idle limit ends in a bare 502, so the agent never learns why (Linear, 2026-11-08: a read of the window after
/// a click ran for over a minute). A blocked Accessibility call cannot be interrupted: the work goes on on its own
/// thread and the next step waits for it or is refused (DesktopControl).
enum StepLimit {
    struct Exceeded: LocalizedError {
        let seconds: TimeInterval
        var errorDescription: String? { "local_action_timeout: the app did not answer within \(Int(seconds)) seconds" }
    }

    /// The work's result, or `Exceeded` once `seconds` have passed without one.
    static func run<T>(seconds: TimeInterval, _ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            let answer = Answer()
            // A thread of its own: a step stuck in an Accessibility call must not hold a thread of Swift's shared pool.
            let thread = Thread {
                let result = Result { try work() }
                if answer.claim() { continuation.resume(with: result) }
            }
            thread.start()
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
                if answer.claim() { continuation.resume(throwing: Exceeded(seconds: seconds)) }
            }
        }
    }

    /// Whoever claims first (the work or the timer) answers; the other is ignored.
    private final class Answer: @unchecked Sendable {
        private let lock = NSLock()
        private var given = false
        func claim() -> Bool { lock.withLock { defer { given = true }; return !given } }
    }
}
