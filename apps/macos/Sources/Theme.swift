import SwiftUI
import AppKit

/// Mirrors the console's Studio language (apps/console/app/styles.css, `--st-*` and `.studio`): a pale ground, flat white
/// cards with a hairline, quiet IBM Plex Sans type and Toru's 3D lens as the mark. Glass stays for the primary pill.
enum Theme {
    /// The ground every window sits on (`--st-ground`).
    static let bg = Color(red: 0xE7/255, green: 0xEC/255, blue: 0xEF/255)
    /// Inset areas inside a card: chips, previews, setup boxes (`--st-window`).
    static let window = Color(red: 0xF3/255, green: 0xF6/255, blue: 0xF8/255)
    /// The selected row in a list (`.studio-rail nav a[aria-current]`).
    static let selected = Color(red: 0xEE/255, green: 0xF2/255, blue: 0xF4/255)
    static let ink = Color(red: 0x22/255, green: 0x31/255, blue: 0x3B/255)
    static let body = Color(red: 0x4B/255, green: 0x5B/255, blue: 0x66/255)
    static let muted = Color(red: 0x64/255, green: 0x72/255, blue: 0x7D/255)
    static let faint = Color(red: 0x89/255, green: 0x96/255, blue: 0xA0/255)
    /// Card outlines and dividers (`--st-line`); `hair` is the lighter rule inside a card.
    static let line = Color(red: 0xE1/255, green: 0xE7/255, blue: 0xEB/255)
    static let hair = Color(red: 0xED/255, green: 0xF1/255, blue: 0xF3/255)
    static let accent = Color(red: 0x40/255, green: 0x5F/255, blue: 0x6D/255)
    static let glass = Color(red: 0xE6/255, green: 0xEE/255, blue: 0xF2/255)
    /// Connected and ready (`--ready`).
    static let ready = Color(red: 0x3F/255, green: 0x6B/255, blue: 0x5C/255)
    static let recording = Color(red: 0xD3/255, green: 0x6B/255, blue: 0x59/255)
    static let danger = Color(red: 0x91/255, green: 0x4E/255, blue: 0x46/255)
    static let shadow = Color(red: 0x2C/255, green: 0x46/255, blue: 0x54/255)
    /// IBM Plex Sans ships in the app (Resources/Fonts, loaded through ATSApplicationFontsPath). Like the site, only Regular
    /// and Medium: heavier weights read as Medium. If the fonts are missing, SwiftUI falls back to the system font.
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom([.medium, .semibold, .bold, .heavy, .black].contains(weight) ? "IBMPlexSans-Medium" : "IBMPlexSans-Regular", size: size)
    }
}

/// The site's ground: two soft tints at the top over `--st-ground`.
struct StudioGround: View {
    var body: some View {
        ZStack {
            Theme.bg
            RadialGradient(colors: [Color(red: 0xDC/255, green: 0xE8/255, blue: 0xF1/255), .clear], center: UnitPoint(x: 0.12, y: 0), startRadius: 0, endRadius: 420)
            RadialGradient(colors: [Color(red: 0xE6/255, green: 0xE1/255, blue: 0xF2/255), .clear], center: UnitPoint(x: 0.9, y: 0.04), startRadius: 0, endRadius: 380)
        }.ignoresSafeArea()
    }
}

/// Toru's lens, the still frame of the turning orb the site and console use. A drawn lens stands in if the image is missing.
struct LensMark: View {
    var size: CGFloat = 24
    private static let orb: NSImage? = Bundle.main.url(forResource: "toru-orb", withExtension: "png").flatMap { NSImage(contentsOf: $0) }
    var body: some View {
        Group {
            if let orb = LensMark.orb {
                Image(nsImage: orb).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
            } else {
                Circle().fill(RadialGradient(colors: [.white, Color(red: 0x90/255, green: 0xA9/255, blue: 0xB5/255), Color(red: 0xA5/255, green: 0xB8/255, blue: 0xC2/255)],
                                             center: UnitPoint(x: 0.35, y: 0.25), startRadius: 0, endRadius: size))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A Studio card: white, 13 pt corners, a hairline and the faintest lift (`.cx-card`).
struct StudioCard: ViewModifier {
    var radius: CGFloat = 13
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(.white))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Theme.line, lineWidth: 1))
            .shadow(color: Theme.shadow.opacity(0.05), radius: 1, y: 1)
    }
}
extension View { func studioCard(radius: CGFloat = 13) -> some View { modifier(StudioCard(radius: radius)) } }

/// Primary action: the glass pill the site and console keep for their main button.
struct InkPillButtonStyle: ButtonStyle {
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(Theme.sans(13, .medium)).foregroundStyle(Theme.ink)
            .padding(.horizontal, 18).frame(minHeight: 38)
            .background(
                Capsule().fill(LinearGradient(stops: [
                    .init(color: .white.opacity(hovering ? 1 : 0.93), location: 0.05),
                    .init(color: Color(red: 0xF1/255, green: 0xF7/255, blue: 0xF9/255).opacity(0.85), location: 0.4),
                    .init(color: Color(red: 0xC7/255, green: 0xD9/255, blue: 0xE3/255).opacity(0.9), location: 1)], startPoint: .topLeading, endPoint: .bottomTrailing))
            )
            .overlay(Capsule().stroke(.white, lineWidth: 1))
            .overlay(Capsule().inset(by: -1).stroke(Color(red: 0xA7/255, green: 0xBD/255, blue: 0xC6/255).opacity(0.34), lineWidth: 1))
            .shadow(color: Color(red: 0x35/255, green: 0x4F/255, blue: 0x64/255).opacity(configuration.isPressed ? 0.04 : 0.08), radius: configuration.isPressed ? 2 : 4, y: configuration.isPressed ? 1 : 4)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(enabled ? 1 : 0.45).onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
/// Secondary action: a flat button on the inset colour with a hairline (`.cx-button`).
struct GlassPillButtonStyle: ButtonStyle {
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(Theme.sans(12.5)).foregroundStyle(Theme.ink)
            .padding(.horizontal, 14).frame(minHeight: 32)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(hovering ? Theme.selected : Theme.window))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.line, lineWidth: 1))
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.5).onHover { hovering = $0 }
    }
}
/// Quiet text action: no chrome; darkens on hover.
struct QuietButtonStyle: ButtonStyle {
    var color: Color = Theme.body
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(Theme.sans(12.5)).foregroundStyle(hovering ? Theme.ink : color)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(hovering ? Theme.window : .clear))
            .opacity(enabled ? (configuration.isPressed ? 0.6 : 1) : 0.4).onHover { hovering = $0 }
    }
}
struct PaleFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration.textFieldStyle(.plain).font(Theme.sans(13)).foregroundStyle(Theme.ink).padding(.horizontal, 10).frame(minHeight: 32)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.white))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.line, lineWidth: 1))
    }
}
