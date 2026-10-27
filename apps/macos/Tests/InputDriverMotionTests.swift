import AppKit

/// Motion and gestures of the operated-window cursor, without a window: only the drawn telemetry is checked.
@main
struct InputDriverMotionTests {
    static func check(_ condition: Bool, _ message: String) {
        if !condition { FileHandle.standardError.write("FAIL: \(message)\n".data(using: .utf8)!); exit(1) }
    }

    static func main() throws {
        check(InputDriver.minimumJerk(0) == 0 && InputDriver.minimumJerk(1) == 1, "minimum jerk ends")
        check(abs(InputDriver.minimumJerk(0.5) - 0.5) < 1e-9, "minimum jerk midpoint")
        check(InputDriver.minimumJerk(0.1) < 0.1, "slow start")
        check(InputDriver.commits("button Criar sinal") && InputDriver.commits("Send") && !InputDriver.commits("Próximo"), "committing labels")

        let window = CGRect(x: 100, y: 100, width: 1200, height: 800)
        let driver = InputDriver(reader: AccessibilityOutline(pid: ProcessInfo.processInfo.processIdentifier, windowID: 0))
        driver.glide(to: CGPoint(x: 1100, y: 800), window: window, kind: "move")
        let moves = driver.telemetry
        check(moves.count > 10, "a travel draws a path")
        let last = moves.last!
        check(abs(last.x - 1000) < 0.5 && abs(last.y - 700) < 0.5, "the travel lands on the target (\(last.x), \(last.y))")
        check(zip(moves, moves.dropFirst()).allSatisfy { $0.atMs < $1.atMs }, "samples move forward in time")

        try driver.gesture("circle", nil, at: CGPoint(x: 600, y: 400), window: window, rows: 4)
        try driver.gesture("underline", nil, at: CGPoint(x: 600, y: 500), window: window, rows: 4)
        try driver.gesture("point", nil, at: CGPoint(x: 300, y: 300), window: window, rows: 4)
        let emphasis = driver.timeline.filter { $0["type"] as? String == "emphasis" }
        check(emphasis.map { $0["gesture"] as? String ?? "" } == ["circle", "underline", "point"], "each gesture is an emphasis moment")
        for moment in emphasis {
            let start = moment["startMs"] as? Int ?? -1, end = moment["endMs"] as? Int ?? -1
            check(start >= 0 && end > start, "a gesture has a start and an end")
            check(moment["frame"] is CGRect, "a gesture is framed")
        }
        let frame = emphasis[0]["frame"] as! CGRect
        check(frame == CGRect(x: 460, y: 288, width: 80, height: 24), "the circle frames the point's box in window points (\(frame))")
        // The loop goes round: the path passes both left and right of the box.
        let loop = driver.telemetry.filter { ($0.atMs >= (emphasis[0]["startMs"] as! Int)) && $0.atMs <= (emphasis[0]["endMs"] as! Int) }
        check(loop.contains { $0.x < 460 } && loop.contains { $0.x > 540 }, "the circle goes around the box")
        do { try driver.gesture("sweep", nil, at: CGPoint(x: 600, y: 400), window: window, rows: 4); check(false, "a sweep needs an element") } catch {}
        do { try driver.gesture("circle", nil, at: CGPoint(x: 5000, y: 400), window: window, rows: 4); check(false, "outside the window is refused") } catch {}
        print("InputDriver motion tests passed")
    }
}
