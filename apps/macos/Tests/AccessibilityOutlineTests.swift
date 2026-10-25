import Foundation
import ApplicationServices

/// swiftc -parse-as-library Sources/AccessibilityOutline.swift Tests/AccessibilityOutlineTests.swift -o /tmp/ax-tests && /tmp/ax-tests
@main struct AccessibilityOutlineTests {
    static func main() {
        let press = [kAXPressAction as String]
        precondition(AccessibilityOutline.map(role: kAXButtonRole as String, subrole: "", actions: press) == "button")
        precondition(AccessibilityOutline.map(role: kAXTextFieldRole as String, subrole: kAXSearchFieldSubrole as String, actions: []) == "searchbox")
        precondition(AccessibilityOutline.map(role: kAXTextAreaRole as String, subrole: "", actions: []) == "textbox")
        precondition(AccessibilityOutline.map(role: kAXPopUpButtonRole as String, subrole: "", actions: press) == "combobox")
        precondition(AccessibilityOutline.map(role: kAXCheckBoxRole as String, subrole: kAXSwitchSubrole as String, actions: press) == "switch")
        precondition(AccessibilityOutline.map(role: kAXRadioButtonRole as String, subrole: "AXTabButton", actions: press) == "tab")
        precondition(AccessibilityOutline.map(role: kAXMenuItemRole as String, subrole: "", actions: press) == "menuitem")
        // Static text and groups are content unless they can be pressed.
        precondition(AccessibilityOutline.map(role: kAXStaticTextRole as String, subrole: "", actions: []) == nil)
        precondition(AccessibilityOutline.map(role: kAXGroupRole as String, subrole: "", actions: press) == "button")
        // Names are JSON strings, so a quote in a title can never end the field early.
        precondition(AccessibilityOutline.json("Say \"hi\"") == "\"Say \\\"hi\\\"\"")
        precondition(AccessibilityOutline.json("a/b") == "\"a/b\"")
        precondition(AccessibilityOutline.jsonArray(["A", "B"]) == "[\"A\",\"B\"]")
        // The user's own name is found wherever an app shows it, in any case; ordinary labels never are.
        if let name = AccessibilityOutline.identityName {
            precondition(AccessibilityOutline.showsIdentity([kAXValueAttribute as String: name]))
            precondition(AccessibilityOutline.showsIdentity([kAXTitleAttribute as String: "Signed in as \(name.uppercased())"]))
            precondition(!AccessibilityOutline.showsIdentity([kAXTitleAttribute as String: "Account"]))
            precondition(!AccessibilityOutline.showsIdentity([kAXValueAttribute as String: String(name.split(separator: " ")[0])]))
            // A label that is the name gets covered; a row summary that mentions it is left to the text inside it.
            precondition(AccessibilityOutline.namesIdentity(name))
            precondition(AccessibilityOutline.namesIdentity("Assigned to \(name)"))
            precondition(!AccessibilityOutline.namesIdentity("Select issue High Priority TOR-4 Todo Single sign-on with Okta Feature \(name)"))
        }
        // An explorer item labelled with its absolute path is named as the screen shows it.
        precondition(AccessibilityOutline.displayName("/tmp/work/toru-skills/README.md") == "README.md")
        precondition(AccessibilityOutline.displayName("/tmp/work/toru-skills/skills") == "skills")
        precondition(AccessibilityOutline.displayName("Toggle Panel (⌘J)") == "Toggle Panel (⌘J)")
        // A code editor's text area, labelled with a screen-reader hint, is named after the document it shows.
        precondition(AccessibilityOutline.isEditorHint("The editor is not accessible at this time. To enable screen reader optimized mode, use Shift+Option+F1"))
        precondition(!AccessibilityOutline.isEditorHint("Search"))
        precondition(AccessibilityOutline.document(inTitle: "README.md — toru-skills") == "README.md")
        precondition(AccessibilityOutline.document(inTitle: "● README.md — toru-skills") == "README.md")
        precondition(AccessibilityOutline.document(inTitle: "toru-skills") == nil)
        // Paragraphs below a web preview's fold are slivers on its bottom edge: the smallest container there scrolls down.
        let window = CGRect(x: 100, y: 100, width: 1440, height: 880)
        let preview = CGRect(x: 456, y: 266, width: 993, height: 688), editor = CGRect(x: 400, y: 226, width: 1100, height: 728)
        let slivers = (0..<4).map { CGRect(x: 460 + Double($0) * 10, y: 952, width: 200, height: 2) }
        let regions = AccessibilityOutline.clippedRegions(squashed: slivers, containers: [editor, preview], window: window)
        precondition(regions.count == 1)
        precondition((regions[0]["wheelAt"] as? [String: Int])?["y"] == Int(preview.midY - window.minY))
        precondition(((regions[0]["remainingPixels"] as? [String: Double])?["down"] ?? 0) > 0)
        precondition(((regions[0]["remainingPixels"] as? [String: Double])?["up"] ?? 1) == 0)
        // One thin rule at an edge is a border, not hidden content.
        precondition(AccessibilityOutline.clippedRegions(squashed: [slivers[0]], containers: [preview], window: window).isEmpty)
        print("AccessibilityOutlineTests passed")
    }
}
