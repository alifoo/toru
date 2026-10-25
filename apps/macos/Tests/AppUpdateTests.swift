import Foundation

@main struct AppUpdateTests {
    static func main() {
        precondition(AppVersion("0.10.0") > AppVersion("0.9.9"))
        precondition(!(AppVersion("1.0") < AppVersion("1.0.0")) && !(AppVersion("1.0.0") < AppVersion("1.0")))
        precondition(AppVersion("dev") < AppVersion("0.0.1"), "unparseable versions are oldest")
        precondition(UpdatePolicy.decision(current: "0.2.0", latest: "0.2.0", minimum: "0.1.0", recording: false) == .none)
        precondition(UpdatePolicy.decision(current: "0.2.0", latest: "0.3.0", minimum: nil, recording: false) == .available("0.3.0"))
        precondition(UpdatePolicy.decision(current: "0.1.0", latest: "0.3.0", minimum: "0.2.0", recording: false) == .required("0.3.0"))
        precondition(UpdatePolicy.decision(current: "0.1.0", latest: nil, minimum: "0.2.0", recording: false) == .required("0.2.0"))
        precondition(UpdatePolicy.decision(current: "0.1.0", latest: "0.3.0", minimum: "0.2.0", recording: true) == .deferred, "never during recording")
        precondition(UpdatePolicy.shouldCheck(lastCheck: nil, recording: false))
        precondition(!UpdatePolicy.shouldCheck(lastCheck: nil, recording: true))
        precondition(!UpdatePolicy.shouldCheck(lastCheck: Date(timeIntervalSinceNow: -3600), recording: false))
        precondition(UpdatePolicy.shouldCheck(lastCheck: Date(timeIntervalSinceNow: -25 * 3600), recording: false))
        precondition(UpdatePolicy.latestVersion(fromManifest: Data(#"{"latest":{"version":"0.3.1"}}"#.utf8)) == "0.3.1")
        precondition(UpdatePolicy.latestVersion(fromManifest: Data(#"{"latest":null}"#.utf8)) == nil)
        precondition(UpdatePolicy.latestVersion(fromManifest: Data(#"{"latest":{"version":"../x"}}"#.utf8)) == nil)
        print("PASS: version ordering, required/available/deferred decisions, daily check cadence, manifest parsing")
    }
}
