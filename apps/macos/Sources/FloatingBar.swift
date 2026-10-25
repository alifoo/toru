import SwiftUI
import AppKit
import CoreImage

/// The default surface of the app: a floating glass bar with everything needed to connect, pick a source and record.
/// It is a non-activating panel on top of other windows and is excluded from every capture (`sharingType = .none`).
@MainActor final class FloatingBar {
    private let panel: NSPanel
    private let host: NSHostingView<FloatingBarView>
    private let effect: NSVisualEffectView
    private(set) var isVisible = false
    init(studio: Studio) {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 56), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.level = .floating; panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
        panel.isMovableByWindowBackground = true; panel.hidesOnDeactivate = false; panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.sharingType = .none; panel.appearance = NSAppearance(named: .aqua)
        // The visual effect view is the window's content, masked to a capsule: that is the reliable way to get
        // behind-window blur on macOS (Spotlight does the same). SwiftUI draws only the controls on top.
        let container = NSView(frame: panel.contentRect(forFrameRect: panel.frame))
        container.wantsLayer = true; container.layer?.backgroundColor = NSColor.clear.cgColor
        effect = NSVisualEffectView(frame: container.bounds)
        effect.material = FloatingBar.material(); effect.blendingMode = .behindWindow; effect.state = .active
        effect.appearance = NSAppearance(named: .aqua); effect.autoresizingMask = [.width, .height]
        effect.maskImage = FloatingBar.capsuleMask()
        effect.alphaValue = FloatingBar.alpha() // the glass is a sibling of the controls, so only the glass gets lighter
        effect.wantsLayer = true
        host = NSHostingView(rootView: FloatingBarView(studio: studio))
        host.frame = container.bounds; host.autoresizingMask = [.width, .height]
        host.wantsLayer = true; host.layer?.backgroundColor = NSColor.clear.cgColor
        container.addSubview(effect); container.addSubview(host)
        panel.contentView = container
        panel.setFrameAutosaveName("ToruFloatingBar")
    }
    /// Design-review overrides: `--material <name>` and `--glass-alpha <0-1>`.
    private static func material() -> NSVisualEffectView.Material {
        let names: [String: NSVisualEffectView.Material] = ["hudWindow": .hudWindow, "fullScreenUI": .fullScreenUI, "popover": .popover, "menu": .menu, "sidebar": .sidebar,
            "underWindowBackground": .underWindowBackground, "titlebar": .titlebar, "headerView": .headerView, "sheet": .sheet, "windowBackground": .windowBackground, "toolTip": .toolTip]
        if let i = CommandLine.arguments.firstIndex(of: "--material"), CommandLine.arguments.count > i + 1, let m = names[CommandLine.arguments[i + 1]] { return m }
        return .hudWindow
    }
    private static func blurRadius() -> Double {
        if let i = CommandLine.arguments.firstIndex(of: "--blur"), CommandLine.arguments.count > i + 1, let v = Double(CommandLine.arguments[i + 1]) { return v }
        return 8
    }
    private static func tintOpacity() -> Double {
        if let i = CommandLine.arguments.firstIndex(of: "--tint"), CommandLine.arguments.count > i + 1, let v = Double(CommandLine.arguments[i + 1]) { return v }
        return 0.35
    }
    private static func alpha() -> CGFloat {
        if let i = CommandLine.arguments.firstIndex(of: "--glass-alpha"), CommandLine.arguments.count > i + 1, let v = Double(CommandLine.arguments[i + 1]) { return CGFloat(v) }
        return 1.0
    }
    private static func capsuleMask() -> NSImage {
        let radius: CGFloat = 29, size = NSSize(width: radius * 2 + 2, height: radius * 2)
        let image = NSImage(size: size, flipped: false) { rect in
            NSColor.black.setFill(); NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill(); return true
        }
        image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        image.resizingMode = .stretch
        return image
    }
    func show() {
        let size = host.fittingSize
        panel.setContentSize(size)
        if !isVisible, panel.frameAutosaveName.isEmpty || panel.frame.origin == .zero, let screen = NSScreen.main {
            panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - size.width / 2, y: screen.visibleFrame.maxY - size.height - 14))
        }
        panel.orderFrontRegardless(); isVisible = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [self] in tuneGlass() }
    }
    /// Liquid-glass tuning on the system material: a much larger blur radius and a lighter tint, both through
    /// key paths the backdrop layer already exposes (no filter replacement, which would disable the blur).
    private func tuneGlass() {
        let radius = FloatingBar.blurRadius()
        func visit(_ layer: CALayer) {
            let isBackdrop = String(describing: type(of: layer)).contains("Backdrop")
            if isBackdrop {
                let names = (layer.filters ?? []).compactMap { ($0 as AnyObject).value(forKey: "name") as? String }
                if names.contains("gaussianBlur") { layer.setValue(radius, forKeyPath: "filters.gaussianBlur.inputRadius") }
                if names.contains("colorSaturate") { layer.setValue(1.5, forKeyPath: "filters.colorSaturate.inputAmount") }
            } else if layer.backgroundColor != nil, layer.sublayers == nil {
                layer.opacity = Float(FloatingBar.tintOpacity()) // the material's tint plate
            }
            for child in layer.sublayers ?? [] { visit(child) }
        }
        if let root = effect.layer { visit(root) }
    }
    func hide() { panel.orderOut(nil); isVisible = false }
    var frameOnScreen: NSRect? { isVisible ? panel.frame : nil }
    func setSharing(_ visible: Bool) { panel.sharingType = visible ? .readOnly : .none }
    func resize() { panel.setContentSize(host.fittingSize) }
}

struct FloatingBarView: View {
    @ObservedObject var studio: Studio
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @State private var sourcesOpen = false
    @State private var accountOpen = false
    private var sourceName: String {
        guard let source = studio.selectedSource else { return "Choose a source" }
        if source.id.hasPrefix("display-") { return "Display \(source.id.dropFirst("display-".count))" }
        return source.title.components(separatedBy: " — ").first ?? source.title
    }
    private var canShare: Bool { !(studio.connected || studio.busy || studio.recording || studio.updateRequired || studio.selection.isEmpty || (!studio.paired && studio.code.isEmpty)) }
    private var canRecord: Bool { !(studio.connected || studio.busy || studio.recording || studio.updateRequired || studio.selection.isEmpty || !studio.paired) }
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "circle.grid.3x3.fill").font(.system(size: 9)).foregroundStyle(Theme.line).padding(.leading, 4).help("Drag to move")
            LensMark(size: 18)
            BarDivider()
            // Account / agent state
            Button { accountOpen.toggle() } label: {
                HStack(spacing: 7) {
                    Circle().fill(studio.recording ? Theme.recording : studio.connected ? Theme.ready : studio.paired ? Theme.faint : Theme.danger).frame(width: 7, height: 7)
                    Text(studio.recording ? "Recording" : studio.connected ? "Connected" : studio.paired ? "Reconnecting…" : "Not paired").font(Theme.sans(12, .medium)).foregroundStyle(Theme.ink)
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.muted)
                }
            }.buttonStyle(BarChipStyle()).help(studio.paired ? "Account and agent connection" : "Pair this Mac with your Toru account").accessibilityLabel("Account")
            .popover(isPresented: $accountOpen, arrowEdge: .bottom) { AccountPopover(studio: studio).frame(width: 300) }
            // Source
            Button { sourcesOpen.toggle() } label: {
                HStack(spacing: 7) {
                    Image(systemName: studio.selectedSource?.id.hasPrefix("display-") == true ? "display" : "macwindow").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    Text(sourceName).font(Theme.sans(12, .medium)).foregroundStyle(Theme.ink).lineLimit(1).frame(maxWidth: 150, alignment: .leading)
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.muted)
                }
            }.buttonStyle(BarChipStyle()).disabled(studio.recording || studio.busy).help("What your agent records next").accessibilityLabel("Source")
            .popover(isPresented: $sourcesOpen, arrowEdge: .bottom) { SourcesPopover(studio: studio, close: { sourcesOpen = false }).frame(width: 320, height: 360) }
            BarDivider()
            // Actions
            if studio.recording {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let seconds = max(0, Int(context.date.timeIntervalSince(studio.capture.started ?? context.date)))
                    HStack(spacing: 7) {
                        Circle().fill(Theme.recording).frame(width: 8, height: 8).opacity(seconds % 2 == 0 ? 1 : 0.4)
                        Text("\(seconds / 60):\(String(format: "%02d", seconds % 60))").font(Theme.sans(13, .medium)).monospacedDigit().foregroundStyle(Theme.ink)
                    }
                }
                Button("Stop") { Task { await studio.stop() } }.buttonStyle(InkPillButtonStyle()).controlSize(.small).accessibilityLabel("Stop").help("Stop and upload")
            } else if studio.uploading {
                ProgressView().controlSize(.small)
                Text(studio.status).font(Theme.sans(12)).foregroundStyle(Theme.ink).lineLimit(1).frame(maxWidth: 160)
                Button("Cancel") { Task { await studio.cancelUpload() } }.buttonStyle(QuietButtonStyle(color: Theme.danger))
            } else if studio.connected {
                Text("Ready").font(Theme.sans(12, .medium)).foregroundStyle(Theme.muted).help("Your agent can record \(sourceName) whenever it needs to.")
                Button { Task { await studio.recordNow() } } label: { Image(systemName: "record.circle").font(.system(size: 15, weight: .medium)).foregroundStyle(canRecord ? Theme.recording : Theme.line) }
                    .buttonStyle(BarIconStyle()).disabled(!canRecord).accessibilityLabel("Record now").help("Record \(sourceName) yourself. Same account and credits; your agent renders it afterwards.")
            } else if studio.paired {
                Button("Connect") { Task { await studio.autoShare() } }.buttonStyle(InkPillButtonStyle()).controlSize(.small).disabled(!canShare).accessibilityLabel("Share selected source").help("Reconnect to your agent.")
            } else {
                Button { accountOpen = true } label: { Label("Pair", systemImage: "link").labelStyle(.titleAndIcon) }.buttonStyle(InkPillButtonStyle()).controlSize(.small).help("Pair this Mac with your Toru account.")
            }
            BarDivider()
            Button { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) } label: { Image(systemName: "rectangle.stack").font(.system(size: 13, weight: .medium)) }
                .buttonStyle(BarIconStyle()).help("Library and preview").accessibilityLabel("Open Toru")
            SettingsLink { Image(systemName: "gearshape").font(.system(size: 13, weight: .medium)) }.buttonStyle(BarIconStyle()).help("Settings").accessibilityLabel("Settings")
            Button { studio.hideBar() } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .bold)) }
                .buttonStyle(BarIconStyle()).help("Hide the bar. Reopen it from the menu bar icon.").accessibilityLabel("Hide bar").padding(.trailing, 2)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Capsule().fill(LinearGradient(colors: [.white.opacity(0.10), .white.opacity(0.02)], startPoint: .top, endPoint: .bottom)))
        .overlay(Capsule().strokeBorder(LinearGradient(colors: [.white.opacity(0.95), .white.opacity(0.35)], startPoint: .top, endPoint: .bottom), lineWidth: 1))
        .fixedSize()
        // Design review aids: `--open-library` and `--open-settings` open those windows at launch, as the bar's buttons do.
        .onAppear {
            if CommandLine.arguments.contains("--open-library") { openWindow(id: "main") }
            if CommandLine.arguments.contains("--open-settings") { openSettings() }
        }
        .onChange(of: studio.recording) { _, _ in studio.resizeBar() }
        .onChange(of: studio.uploading) { _, _ in studio.resizeBar() }
        .onChange(of: studio.connected) { _, _ in studio.resizeBar() }
        .onChange(of: studio.selection) { _, _ in studio.resizeBar() }
    }
}

struct BarDivider: View { var body: some View { Rectangle().fill(Theme.line.opacity(0.7)).frame(width: 1, height: 22) } }

struct BarChipStyle: ButtonStyle {
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.padding(.horizontal, 10).frame(minHeight: 30)
            .background(Capsule().fill(Color.white.opacity(hovering ? 0.75 : 0.5)))
            .overlay(Capsule().stroke(.white.opacity(0.9), lineWidth: 1))
            .shadow(color: Theme.shadow.opacity(0.08), radius: 3, y: 1)
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.5).onHover { hovering = $0 }
    }
}
struct BarIconStyle: ButtonStyle {
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.foregroundStyle(hovering ? Theme.ink : Theme.accent).frame(width: 30, height: 30)
            .background(Circle().fill(Color.white.opacity(hovering ? 0.8 : 0.5)))
            .overlay(Circle().stroke(.white.opacity(0.9), lineWidth: 1))
            .shadow(color: Theme.shadow.opacity(0.08), radius: 3, y: 1)
            .opacity(enabled ? (configuration.isPressed ? 0.6 : 1) : 0.4).onHover { hovering = $0 }
    }
}

struct SourcesPopover: View {
    @ObservedObject var studio: Studio
    let close: () -> Void
    private var windows: [CaptureSource] { studio.sources.filter { !$0.id.hasPrefix("display-") } }
    private var displays: [CaptureSource] { studio.sources.filter { $0.id.hasPrefix("display-") } }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("What to record").font(Theme.sans(13, .medium)).foregroundStyle(Theme.ink)
                Spacer()
                Button { Task { await studio.refresh() } } label: { Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted) }.buttonStyle(.plain).help("Refresh").accessibilityLabel("Refresh")
            }.padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if studio.sources.isEmpty { Text("No windows listed").font(Theme.sans(12)).foregroundStyle(Theme.muted).padding(8) }
                    if !windows.isEmpty {
                        Text("Windows").font(Theme.sans(11, .medium)).foregroundStyle(Theme.muted).padding(.horizontal, 10).padding(.top, 2)
                        ForEach(windows) { source in SourceRow(source: source, selected: source.id == studio.selection) { studio.selection = source.id; close() } }
                    }
                    if !displays.isEmpty {
                        Text("Displays").font(Theme.sans(11, .medium)).foregroundStyle(Theme.muted).padding(.horizontal, 10).padding(.top, 10)
                        ForEach(displays) { source in SourceRow(source: source, selected: source.id == studio.selection) { studio.selection = source.id; close() } }
                    }
                }.padding(.horizontal, 8).padding(.bottom, 8)
            }
            Rectangle().fill(Theme.hair).frame(height: 1)
            Button("Choose with the system picker…") { close(); studio.chooseSource() }.buttonStyle(QuietButtonStyle()).padding(.horizontal, 10).padding(.vertical, 6)
                .accessibilityLabel("Choose window or display")
        }.background(.white)
    }
}

struct AccountPopover: View {
    @ObservedObject var studio: Studio
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if studio.paired {
                HStack(spacing: 8) {
                    Circle().fill(studio.recording ? Theme.recording : studio.connected ? Theme.ready : Theme.faint).frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(studio.recording ? "Recording" : studio.connected ? "Connected" : "Reconnecting…").font(Theme.sans(13, .medium)).foregroundStyle(Theme.ink)
                        Text(URL(string: studio.server)?.host ?? studio.server).font(Theme.sans(11)).foregroundStyle(Theme.muted)
                    }
                }
                Text(studio.connected ? "Your agent can record \(studio.selectedSource.map { $0.title.components(separatedBy: " — ").first ?? $0.title } ?? "the selected source") whenever it needs to. Change the source in the bar; disconnect in Settings." : "Reconnecting to your agent. If this takes long, check your network or open Settings.").font(Theme.sans(12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Open Connections") { NSWorkspace.shared.open(studio.consoleURL(view: "agents")) }.buttonStyle(QuietButtonStyle())
                    Spacer()
                    SettingsLink { Text("Settings") }.buttonStyle(QuietButtonStyle())
                }
            } else {
                Text("Pair this Mac").font(Theme.sans(13, .medium)).foregroundStyle(Theme.ink)
                TextField("Server", text: $studio.server).textFieldStyle(PaleFieldStyle()).disabled(studio.busy)
                SecureField("One-time code", text: $studio.code).textFieldStyle(PaleFieldStyle()).disabled(studio.busy)
                Text("Open the setup link from your agent or from Connections in the Toru console; the Mac connects by itself. Or paste the code here.").font(Theme.sans(11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Open Connections") { NSWorkspace.shared.open(studio.consoleURL(view: "agents")) }.buttonStyle(QuietButtonStyle())
                    Spacer()
                    Button("Pair") { Task { if studio.sources.isEmpty { await studio.refresh() }; if studio.selection.isEmpty, let first = studio.sources.first(where: { $0.id.hasPrefix("display-") }) ?? studio.sources.first { studio.selection = first.id }; await studio.pair() } }.buttonStyle(InkPillButtonStyle()).controlSize(.small).disabled(studio.code.isEmpty || studio.busy)
                }
            }
        }.padding(16).background(.white)
    }
}

