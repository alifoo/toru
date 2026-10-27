import SwiftUI
import ScreenCaptureKit
import AVFoundation
import AppKit
import os

/// Local unified-log trail for support (`log show --predicate 'subsystem == "tools.toru.mac"'`). Status text only; no codes or credentials.
let toruLog = Logger(subsystem: "tools.toru.mac", category: "studio")

struct CaptureSource: Identifiable {
    let id: String
    let title: String
    let filter: SCContentFilter
    let width: Int
    let height: Int
    /// Identity used only to detect that the chosen source disappeared; never to pick a replacement.
    var windowIDs: [CGWindowID] = []
    var displayIDs: [CGDirectDisplayID] = []
}
struct ToruError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
struct ToruHTTPError: LocalizedError {
    let status: Int
    let code: String?
    var errorDescription: String? { CaptureGuards.describe(serverCode: code, status: status) }
    /// A restart (a deploy), an overloaded proxy or a dropped session: the same pairing works again in a moment.
    var transient: Bool { [0, 408, 425, 429, 500, 502, 503, 504].contains(status) || code == "local_browser_disconnected" }
}

@MainActor
final class Capture: NSObject, SCStreamDelegate {
    var stream: SCStream?
    private var writer: CaptureWriter?
    var failure: Error?
    var started: Date?
    var durationMs = 0
    private var stopTask: Task<URL, Error>?
    var file: URL?
    var width = 1280
    var height = 720
    /// Off while Toru operates the window: the video's cursor is drawn from Toru's own telemetry, not the user's mouse.
    var showsCursor = true
    var onFailure: ((String) -> Void)?
    var onFailureError: ((Error) -> Void)?
    /// A window's menus, popovers and sheets are windows of their own, so a capture of the window alone never shows
    /// the menu it opens. When the shared window is on screen, record its rectangle of the display with only its
    /// own app's windows in it: its menus and popups appear, no other app does. Off screen (another space), the
    /// window alone, as before.
    static func withPopups(_ source: CaptureSource, config: SCStreamConfiguration) async -> (filter: SCContentFilter, region: CGRect?, points: CGSize) {
        guard let id = source.windowIDs.first,
              let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false),
              let window = content.windows.first(where: { $0.windowID == id })
        else { return (source.filter, nil, source.filter.contentRect.size) }
        // The window as it is now (Toru may have just resized it), not as it was when the list was read.
        guard window.isOnScreen, let app = window.owningApplication,
              let display = content.displays.first(where: { $0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY)) })
        else { return (SCContentFilter(desktopIndependentWindow: window), nil, window.frame.size) }
        let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        // The window with a margin around it: a menu that opens past the window's edge is recorded whole. Nothing of
        // another app is in it; outside the app's windows the render paints its background (see CaptureLayers).
        let region = CaptureLayers.region(window: window.frame, display: display.frame)
        // Display-local points, the space sourceRect is measured in.
        config.sourceRect = region.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        return (filter, region, region.size)
    }

    /// The recorded region in screen points, when it is the window with a margin (nil: the window alone).
    private(set) var region: CGRect?
    private(set) var layers = CaptureLayers()
    private var layerWatch: Task<Void, Never>?

    /// What of the app is on screen inside the region: the shared window, windows over it (sheets, dialogs) and
    /// popups (menus, popovers), sampled 30 times a second while recording and kept when they change.
    private func watchLayers(windowID: CGWindowID, pid: pid_t, region: CGRect) {
        layerWatch?.cancel()
        layers = CaptureLayers()
        let windowRadius: CGFloat
        if #available(macOS 26, *) { windowRadius = 26 } else { windowRadius = 10 }
        layerWatch = Task { @MainActor [weak self] in
            while !Task.isCancelled, let self {
                let infos = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
                var shared: CGRect?
                var frames: [(frame: CGRect, radius: CGFloat, kind: String)] = []
                // Front to back; drawn back to front, so the list is reversed below.
                for info in infos where (info[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid {
                    guard let raw = info[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: raw),
                          frame.width > 20, frame.height > 20, frame.intersects(region) else { continue }
                    let layer = info[kCGWindowLayer as String] as? Int ?? 0
                    let number = (info[kCGWindowNumber as String] as? Int).map(CGWindowID.init)
                    if number == windowID { shared = frame; frames.append((frame, windowRadius, "window")); continue }
                    // The menu bar and status items are not the app's content.
                    if layer == Int(CGWindowLevelForKey(.mainMenuWindow)) || layer == Int(CGWindowLevelForKey(.statusWindow)) { continue }
                    if layer == 0 {
                        // Another window of the app counts only when it sits over the shared one (a sheet, a dialog).
                        guard let shared, frame.intersects(shared), frame.width * frame.height < shared.width * shared.height else { continue }
                        frames.append((frame, windowRadius, "window"))
                    } else {
                        // A menu fading in or out is partly transparent, which the recording keeps as black: it is
                        // shown only while it is opaque.
                        guard (info[kCGWindowAlpha as String] as? Double ?? 1) >= 0.97 else { continue }
                        frames.append((frame, 12, "popup"))
                    }
                }
                let atMs = self.started.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
                self.layers.note(atMs: atMs, rects: CaptureLayers.rects(frames.reversed(), in: region))
                try? await Task.sleep(for: .milliseconds(33))
            }
        }
    }

    /// The encoding of the current or last recording.
    private(set) var encoding: CaptureEncoding?

    func start(_ source: CaptureSource, file url: URL) async throws {
        guard stream == nil else { throw ToruError(message: "Already recording") }
        let config = SCStreamConfiguration()
        let (filter, region, points) = await Self.withPopups(source, config: config)
        // Recorded at the screen's own density (2 on Retina) up to 2560x1440; a Mac that cannot encode that size
        // records 1920x1080, then 1280x720, as Toru for Chrome does.
        let candidates = CaptureEncoding.candidates(width: Double(points.width), height: Double(points.height), pixelScale: Double(filter.pointPixelScale))
        guard !candidates.isEmpty else {
            throw ToruError(message: "This source cannot be recorded. Choose another window or display.")
        }
        let usable = candidates.filter(CaptureWriter.canEncode)
        guard !usable.isEmpty else { throw ToruError(message: "This Mac cannot encode a video of this source.") }
        self.region = region
        config.queueDepth = 6; config.showsCursor = showsCursor
        config.capturesAudio = false
        var lastError: Error = ToruError(message: "Recording did not start. Check screen recording permission.")
        for (index, encoding) in usable.enumerated() {
            do { try await start(filter: filter, config: config, encoding: encoding, file: url, source: source); return }
            catch let error as EncoderRejected {
                // The encoder refused this size after all: try the next one down.
                lastError = error.underlying
                toruLog.notice("encoder rejected \(encoding.size.width)x\(encoding.size.height); \(index + 1 < usable.count ? "trying a smaller size" : "no smaller size", privacy: .public)")
                try? FileManager.default.removeItem(at: url)
            }
        }
        throw ToruError(message: CaptureGuards.describe(lastError))
    }
    /// The writer failed before the first frame: the encoder does not take this size.
    private struct EncoderRejected: Error { let underlying: Error }

    private func start(filter: SCContentFilter, config: SCStreamConfiguration, encoding: CaptureEncoding, file url: URL, source: CaptureSource) async throws {
        let output: CaptureWriter
        do { output = try CaptureWriter(url: url, encoding: encoding) } catch { throw EncoderRejected(underlying: error) }
        output.configure(config)
        width = encoding.size.width; height = encoding.size.height; self.encoding = encoding
        output.onFirstFrame = { [weak self] in
            Task { @MainActor in guard let self, self.writer === output, self.started == nil else { return }; self.started = Date() }
        }
        output.onFailure = { [weak self] error in
            Task { @MainActor in
                guard let self, self.writer === output else { return }
                self.failure = error
                // Before the first frame, start() reports it (and may try a smaller size); the share is not ended.
                guard self.started != nil else { return }
                self.onFailureError?(error); self.onFailure?(CaptureGuards.describe(error))
            }
        }
        let next = SCStream(filter: filter, configuration: config, delegate: self)
        try next.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
        failure = nil; started = nil; durationMs = 0; stopTask = nil
        file = url; writer = output; stream = next
        do {
            try await next.startCapture()
            for _ in 0..<100 {
                if let failure {
                    // Nothing was written yet: the encoder refused the size rather than the source going away.
                    if started == nil, (failure as NSError).domain == AVFoundationErrorDomain { throw EncoderRejected(underlying: failure) }
                    throw failure
                }
                if started != nil {
                    if let region, let id = source.windowIDs.first,
                       let owner = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first?[kCGWindowOwnerPID as String] as? Int {
                        watchLayers(windowID: id, pid: pid_t(owner), region: region)
                    } else { layers = CaptureLayers() }
                    return
                }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw ToruError(message: "Recording did not start. Check screen recording permission.")
        } catch {
            try? await next.stopCapture()
            output.cancel()
            stream = nil; writer = nil; stopTask = nil
            throw error
        }
    }
    func stop() async throws -> URL {
        if let stopTask { return try await stopTask.value }
        layerWatch?.cancel(); layerWatch = nil
        let task = Task { @MainActor () async throws -> URL in
            defer { self.stream = nil }
            // The file ends when Stop was pressed, even if stopping the stream takes a moment.
            let end = CaptureWriter.now()
            if let active = self.stream { try? await active.stopCapture() }
            guard let output = self.writer, let file = self.file else { throw ToruError(message: "Capture could not finish. Any saved video remains in Movies/Toru.") }
            do {
                // After a stream failure (window closed, display unplugged) the frames written so far are kept.
                try await output.finish(at: end)
                return try await self.validated(file)
            } catch {
                if let failure = self.failure { throw ToruError(message: CaptureGuards.describe(failure)) }
                throw ToruError(message: "Capture could not finish. Any saved video remains in Movies/Toru. \(error.localizedDescription)")
            }
        }
        stopTask = task
        return try await task.value
    }
    private func validated(_ file: URL) async throws -> URL {
        let duration = try await AVURLAsset(url: file).load(.duration).seconds
        guard duration.isFinite && duration > 0 else { throw ToruError(message: "The saved capture is incomplete.") }
        durationMs = Int(duration * 1000)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return file
    }
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            guard self.stream === stream else { return }
            self.failure = error; self.onFailureError?(error); self.onFailure?(CaptureGuards.describe(error))
        }
    }
}

@MainActor
final class Studio: ObservableObject {
    @Published var server = "https://mcp.toru.tools"
    /// The console that goes with the paired server: Toru's own for mcp.toru.tools, otherwise the `consoleURL` default
    /// (`defaults write tools.toru.mac consoleURL https://…`) or the server itself, for a self-hosted Toru.
    func consoleURL(view: String) -> URL {
        let host = URL(string: server)?.host
        let base = UserDefaults.standard.string(forKey: "consoleURL") ?? (host == nil || host == "mcp.toru.tools" ? "https://app.toru.tools" : server)
        return URL(string: "\(base.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/#\(view)") ?? URL(string: "https://app.toru.tools/#\(view)")!
    }
    @Published var code = ""
    @Published var sources: [CaptureSource] = []
    /// Last chosen source, by title, so relaunches and refreshes keep the user's pick without a click.
    private func defaultSource() -> CaptureSource? {
        if let title = UserDefaults.standard.string(forKey: "lastSourceTitle"), let match = sources.first(where: { $0.title == title }) { return match }
        return sources.first { $0.id.hasPrefix("display-") } ?? sources.first
    }
    @Published var selection = "" {
        didSet {
            if let title = selectedSource?.title, !selection.isEmpty { UserDefaults.standard.set(title, forKey: "lastSourceTitle") }
            toruLog.notice("selection changed blocker=\(self.shareBlocker ?? "none", privacy: .public)")
            if selection != oldValue { preview = nil; Task { await refreshPreview() } }
        }
    }
    /// One still frame of the chosen source, so the user sees exactly what will be recorded. Never taken while recording.
    @Published var preview: NSImage?
    @Published private(set) var thumbnails: [UUID: NSImage] = [:]
    func thumbnail(for entry: LocalCapture) async {
        guard thumbnails[entry.id] == nil, entry.stage != .recording, entry.stage != .finalizing else { return }
        let file = journal.file(for: entry)
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
        generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 240, height: 160)
        if let (image, _) = try? await generator.image(at: CMTime(seconds: 0.5, preferredTimescale: 600)) {
            thumbnails[entry.id] = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
        }
    }
    var selectedSource: CaptureSource? { sources.first { $0.id == selection } }
    /// Short human name of the selection: the app name for windows, "Display N" for displays.
    var selectedSourceName: String {
        guard let source = selectedSource else { return "the selected source" }
        if source.id.hasPrefix("display-") { return "Display \(source.id.dropFirst("display-".count))" }
        return source.title.components(separatedBy: " — ").first ?? source.title
    }
    func refreshPreview() async {
        guard !recording, let source = selectedSource else { return }
        let config = SCStreamConfiguration()
        let scale = max(1, Double(source.width) / 720)
        config.width = Int(Double(source.width) / scale); config.height = Int(Double(source.height) / scale)
        config.showsCursor = false
        if let image = try? await SCScreenshotManager.captureImage(contentFilter: source.filter, configuration: config), selection == source.id {
            preview = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
        }
    }
    @Published var consent = false { didSet { toruLog.notice("consent=\(self.consent) blocker=\(self.shareBlocker ?? "none", privacy: .public)") } }
    @Published var connected = false
    @Published var paired = false
    private var identity: DeviceIdentity?
    @Published var busy = false
    @Published var recording = false
    @Published var recordingSource = ""
    @Published var uploading = false
    /// A recording the user started from the app, without an agent command. Same account, job and credit path.
    @Published var manual = false
    private var manualTask: Task<Void, Never>?
    @Published var status = "Choose a source, then pair with your agent." {
        didSet { toruLog.notice("status: \(self.status, privacy: .public)") }
    }
    @Published var saved: URL?
    @Published var recent: [LocalCapture] = []
    /// Off by default. When on, failures send only an event name, an error code and the app version.
    /// Off by default. When on, Toru's navigator may click and type in the shared window during agent recordings.
    @Published var allowControl = UserDefaults.standard.bool(forKey: "allowControl") {
        didSet {
            UserDefaults.standard.set(allowControl, forKey: "allowControl")
            if allowControl && !DesktopControl.available { DesktopControl.requestPermission() }
            control = nil
        }
    }
    private var control: DesktopControl?
    /// Control is offered only for a shared window, with the user's setting and macOS permission.
    var controlReady: Bool { allowControl && DesktopControl.available && (selectedSource?.windowIDs.isEmpty == false) }
    private func desktopControl() throws -> DesktopControl {
        guard allowControl else { throw ToruError(message: "local_method_forbidden: turn on Let your agent operate the shared window in Toru Settings") }
        guard let windowID = selectedSource?.windowIDs.first else { throw ToruError(message: "local_method_forbidden: share a window, not a display") }
        if let control, control.pid == (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first?[kCGWindowOwnerPID as String] as? Int32 { return control }
        let created = try DesktopControl(windowID: windowID)
        control = created
        return created
    }
    @Published var diagnosticsOptIn = UserDefaults.standard.bool(forKey: "diagnosticsOptIn") {
        didSet { UserDefaults.standard.set(diagnosticsOptIn, forKey: "diagnosticsOptIn") }
    }
    @Published var update: UpdateDecision = .none
    static let manifestURL = URL(string: "https://toru.tools/downloads/mac.json")!
    static let downloadPage = URL(string: "https://toru.tools/mac")!
    private var lastErrorCode = "none"
    static let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    /// The floating bar is the default surface; the main window is the library and preview.
    @Published var showHUD = UserDefaults.standard.object(forKey: "showBar") as? Bool ?? true {
        didSet { UserDefaults.standard.set(showHUD, forKey: "showBar"); showHUD ? bar.show() : bar.hide() }
    }
    private lazy var bar = FloatingBar(studio: self)
    func showBar() { showHUD = true; bar.show() }
    func snapshotBar(to path: String) async {
        let screenID = (NSScreen.main?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        guard bar.frameOnScreen != nil, let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
              let display = content.displays.first(where: { $0.displayID == screenID }) ?? content.displays.first else { return }
        bar.setSharing(true); defer { bar.setSharing(false) }
        let config = SCStreamConfiguration()
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        config.width = display.width * Int(scale); config.height = display.height * Int(scale); config.showsCursor = false
        // Capture the whole display, then crop around the bar (window coordinates are bottom-left; display rect is top-left).
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config) else { return }
        // Whole display; the reviewer crops using the bar's accessibility frame.
        let rep = NSBitmapImageRep(cgImage: image)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        toruLog.notice("snapshot written")
    }
    func hideBar() { showHUD = false; bar.hide() }
    func resizeBar() { bar.resize() }
    @Published var autoTrashUploaded = UserDefaults.standard.object(forKey: "autoTrashUploaded") as? Bool ?? true {
        didSet { UserDefaults.standard.set(autoTrashUploaded, forKey: "autoTrashUploaded") }
    }
    let journal: CaptureJournal
    private var current: LocalCapture?
    private var disconnecting = false
    private var connectionGeneration = UUID()
    let capture = Capture()
    private var token: String?
    private var endpoint: URL?
    private var loop: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var systemObservers: [any NSObjectProtocol] = []
    private lazy var sourcePicker: SourcePicker = {
        let picker = SourcePicker()
        picker.selected = { [weak self] source in
            guard let self, !self.recording, !self.busy else { return }
            self.sources = [source]; self.selection = source.id
            self.status = "Source selected. Approve recording and upload before sharing."
        }
        picker.canceled = { [weak self] in self?.status = "Selection canceled. Choose a source when ready." }
        picker.failed = { [weak self] in self?.status = "Could not select this source. Try another window or check Screen Recording in System Settings. Protected content may not be recordable." }
        return picker
    }()
    /// toru-mac://pair?server=…&code=… from the console or an agent. It only prefills fields; sharing still needs a source and consent.
    func applySetupLink(_ url: URL) {
        guard url.scheme == "toru-mac" else { return }
        guard url.host == "pair", let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            status = "This Toru link is not supported."; return
        }
        guard !connected && !recording && !busy else { status = "Finish or stop the current recording before using a setup link."; return }
        let serverValue = items.first { $0.name == "server" }?.value ?? "", codeValue = items.first { $0.name == "code" }?.value ?? ""
        guard let target = URL(string: serverValue), target.user == nil, target.password == nil, target.query == nil, target.fragment == nil,
              target.path.isEmpty || target.path == "/",
              target.scheme == "https" || (target.scheme == "http" && ["127.0.0.1", "localhost"].contains(target.host ?? "")) else {
            status = "The setup link points to an unsupported server. Use an HTTPS Toru server."; return
        }
        if server != serverValue {
            server = serverValue
            identity = try? DeviceKeychain.load(server: server); paired = identity != nil
        }
        if paired {
            code = ""
            status = "This Mac is already paired with \(target.host ?? "this server")."
            Task { @MainActor in await autoShare() }
        } else {
            code = codeValue
            if codeValue.isEmpty { status = "Setup link received without a code. Ask for a new link."; return }
            status = "Setup link received. Connecting…"
            Task { @MainActor in
                if sources.isEmpty { await refresh() }
                if selection.isEmpty { selection = defaultSource()?.id ?? "" }
                await pair()
                if connected { showBar() }
            }
        }
    }
    func chooseSource() {
        guard !busy && !recording else { return }
        consent = false; selection = ""; sources = []
        sourcePicker.present()
    }
    init(journal: CaptureJournal = CaptureJournal()) {
        self.journal = journal
        do { recent = try journal.recover() }
        catch { status = "Could not read local recording history. Your files remain in Movies/Toru." }
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--server"), args.count > i+1 { server = args[i+1] }
        if let i = args.firstIndex(of: "--code"), args.count > i+1 { code = args[i+1] }
        do {
            identity = try DeviceKeychain.load(server: server)
            paired = identity != nil
            if paired { status = "Mac paired. Select a source and approve a new recording." }
        } catch { status = error.localizedDescription }
        capture.onFailure = { [weak self] message in Task { await self?.disconnect(message: message) } }
        capture.onFailureError = { [weak self] error in self?.diagnose("capture_failed", error) }
        observeSystemEvents()
        Task { await applyRetention() }
        Task { await checkForUpdate() }
        if showHUD { Task { @MainActor in self.bar.show() } }
        // List sources without a click once Screen Recording is already granted; a first run still asks on Refresh.
        if CGPreflightScreenCaptureAccess() { Task { await refresh(); await autoShare() } }
        // Development: `--pair` pairs with --server/--code at launch, as opening a setup link does, and reports the
        // state on stderr. Scripts use it instead of clicking Share.
        if args.contains("--pair") {
            Task { @MainActor in
                let report = { (line: String) in FileHandle.standardError.write("toru: \(line)\n".data(using: .utf8)!) }
                report("screen recording \(CGPreflightScreenCaptureAccess()) accessibility \(DesktopControl.available) control setting \(self.allowControl)")
                await self.refresh()
                if self.selection.isEmpty { self.selection = self.defaultSource()?.id ?? "" }
                report("sources \(self.sources.count) selected \(self.selection.isEmpty ? "none" : "set")")
                await self.pair()
                report("connected \(self.connected): \(self.status)")
            }
        }
        systemObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier == Bundle.main.bundleIdentifier else { return }
            Task { @MainActor in
                guard let self, !self.connected, !self.recording, !self.busy, CGPreflightScreenCaptureAccess() else { return }
                await self.refresh(); await self.autoShare()
            }
        })
    }
    /// Daily manifest check; the paired server's minimum version is learned from its 426 replies or /version. Never during recording.
    func checkForUpdate(force: Bool = false) async {
        let last = UserDefaults.standard.object(forKey: "lastUpdateCheck") as? Date
        guard force || UpdatePolicy.shouldCheck(lastCheck: last, recording: recording) else { return }
        guard !recording else { return }
        var latest: String?, minimum: String?
        if let (data, response) = try? await ToruNetwork.session.data(from: Studio.manifestURL), (response as? HTTPURLResponse)?.statusCode == 200 {
            latest = UpdatePolicy.latestVersion(fromManifest: data)
        }
        if let endpoint, let (data, _) = try? await ToruNetwork.session.data(from: endpoint.appendingPathComponent("local-browser/version")),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            minimum = json["minimumAppVersion"] as? String
            if latest == nil, let served = json["latestAppVersion"] as? String { latest = served }
        }
        UserDefaults.standard.set(Date(), forKey: "lastUpdateCheck")
        update = UpdatePolicy.decision(current: Studio.appVersion, latest: latest, minimum: minimum, recording: recording)
    }
    func openDownloadPage() { NSWorkspace.shared.open(Studio.downloadPage) }
    /// Why Share / Record now is unavailable right now, in the user's words. Nil when ready.
    var shareBlocker: String? {
        if connected { return nil }
        if busy { return "Working…" }
        if recording { return "Stop the current recording first." }
        if updateRequired { return "Update Toru to keep recording." }
        if selection.isEmpty || !sources.contains(where: { $0.id == selection }) { return "Choose a window or display first." }
        if !paired && code.isEmpty { return "Enter the one-time code from your agent or the console, or open the setup link." }
        return nil
    }
    var updateRequired: Bool { if case .required = update { return true } else { return false } }
    /// Uploaded local copies older than 30 days go to the Trash (recoverable). Nothing else is removed automatically.
    func applyRetention() async {
        guard autoTrashUploaded, !busy, !recording else { return }
        for entry in CaptureJournal.expired(recent) where current?.id != entry.id {
            let file = journal.file(for: entry)
            do {
                if FileManager.default.fileExists(atPath: file.path) {
                    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                        NSWorkspace.shared.recycle([file]) { _, error in
                            if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                        }
                    }
                }
                try journal.removeManifest(for: entry)
            } catch { continue } // Leave the copy; a failed cleanup must never block recording.
        }
        recent = (try? journal.load()) ?? recent
    }
    /// Sleep, lock and session switches end the lease: the armed consent must not outlive what the user can see.
    private func observeSystemEvents() {
        let message = "Mac went to sleep, locked or switched user. Recording stopped and any local capture was saved. Approve a new recording to continue."
        let handler: @Sendable (Notification) -> Void = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.connected || self.recording else { return }
                await self.disconnect(message: message)
            }
        }
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.screensDidSleepNotification] {
            systemObservers.append(workspace.addObserver(forName: name, object: nil, queue: .main, using: handler))
        }
        systemObservers.append(DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main, using: handler))
    }
    /// Watches the recorded source and free disk space; any violation stops safely without switching source.
    private func watch(source: CaptureSource, generation: UUID) {
        watchdog?.cancel()
        let windowIDs = source.windowIDs, displayIDs = source.displayIDs
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: CaptureGuards.watchInterval)
                guard let self, !Task.isCancelled, self.recording, self.connectionGeneration == generation else { return }
                if let message = CaptureGuards.recordingBlocked(freeBytes: CaptureGuards.freeBytes(at: self.journal.directory)) {
                    await self.disconnect(message: message); return
                }
                guard !windowIDs.isEmpty || !displayIDs.isEmpty else { continue }
                guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) else { continue }
                let presence = CaptureGuards.presence(windowIDs: windowIDs, displayIDs: displayIDs,
                                                      windows: content.windows.map { ($0.windowID, $0.isOnScreen) },
                                                      displays: content.displays.map(\.displayID))
                guard self.recording, self.connectionGeneration == generation else { return }
                if let message = CaptureGuards.message(for: presence) { await self.disconnect(message: message); return }
            }
        }
    }
    /// Rotates the access credential before it expires so an idle connection does not drop (no capture command involved).
    private func scheduleRefresh(generation: UUID) {
        refreshTask?.cancel()
        guard let identity else { return }
        let delay = max(5, identity.accessExpiresAt / 1000 - Date().timeIntervalSince1970 - 120)
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, self.connected, self.connectionGeneration == generation, let current = self.identity else { return }
            do {
                try self.remember(try await self.post("device/refresh", ["refreshToken": current.refreshToken]))
                guard self.connected, self.connectionGeneration == generation else { return }
                self.scheduleRefresh(generation: generation)
            } catch {
                guard self.connected, self.connectionGeneration == generation else { return }
                if let http = error as? ToruHTTPError, http.status == 401 { await self.disconnect(message: http.localizedDescription) }
                else { self.scheduleRefresh(generation: generation) }
            }
        }
    }
    func refresh() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            sources = content.windows.filter { $0.frame.width >= 320 && $0.frame.height >= 200 && $0.title?.isEmpty == false }.map {
                CaptureSource(id: "window-\($0.windowID)", title: "\($0.owningApplication?.applicationName ?? "App") — \($0.title ?? "Window")", filter: SCContentFilter(desktopIndependentWindow: $0), width: Int($0.frame.width), height: Int($0.frame.height), windowIDs: [$0.windowID])
            } + content.displays.map {
                CaptureSource(id: "display-\($0.displayID)", title: "Entire display \($0.displayID) (includes other visible apps)", filter: SCContentFilter(display: $0, excludingWindows: []), width: $0.width, height: $0.height, displayIDs: [$0.displayID])
            }
            if !sources.contains(where: { $0.id == selection }) { selection = "" }
            if selection.isEmpty { selection = defaultSource()?.id ?? "" }
            toruLog.notice("refresh listed \(content.windows.count) windows and \(content.displays.count) displays")
            if !connected { status = "Select only the content you want to share." }
        } catch {
            toruLog.error("refresh failed: \(error.localizedDescription, privacy: .public) domain=\((error as NSError).domain, privacy: .public) code=\((error as NSError).code)")
            status = "Allow Toru in System Settings → Privacy & Security → Screen & System Audio Recording, then refresh. \(error.localizedDescription)"
        }
    }
    private func validatedEndpoint() throws -> URL {
        guard let url = URL(string: server), url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (url.scheme == "http" && ["127.0.0.1", "localhost"].contains(url.host ?? "")) else {
            throw ToruError(message: "Use an HTTPS server, or localhost for development.")
        }
        return url
    }
    private func post(_ path: String, _ value: [String: Any] = [:], file: URL? = nil, chunk: Data? = nil, offset: Int? = nil) async throws -> [String: Any] {
        guard let endpoint else { throw ToruError(message: "Not connected") }
        var request = URLRequest(url: endpoint.appendingPathComponent("local-browser/" + path))
        request.httpMethod = "POST"; request.timeoutInterval = file == nil ? 30 : 120
        request.setValue(file == nil && chunk == nil ? "application/json" : "application/octet-stream", forHTTPHeaderField: "Content-Type")
        if let offset { request.setValue(String(offset), forHTTPHeaderField: "X-Toru-Offset") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.setValue(Studio.appVersion, forHTTPHeaderField: "X-Toru-App-Version")
        let data: Data
        let response: URLResponse
        if let chunk {
            (data, response) = try await ToruNetwork.session.upload(for: request, from: chunk)
        } else if let file {
            (data, response) = try await ToruNetwork.session.upload(for: request, fromFile: file)
        } else {
            request.httpBody = try JSONSerialization.data(withJSONObject: value)
            (data, response) = try await ToruNetwork.session.data(for: request)
        }
        guard let response = response as? HTTPURLResponse else { throw ToruHTTPError(status: 0, code: nil) }
        guard response.statusCode == 200 else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let code = payload?["error"] as? String
            if response.statusCode == 426 {
                update = .required((payload?["latestAppVersion"] as? String) ?? (payload?["minimumAppVersion"] as? String) ?? "a newer version")
            }
            throw ToruHTTPError(status: response.statusCode, code: code)
        }
        return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
    /// Pairing is the authorization. A paired Mac shares its chosen (or main display) source by itself; the bar
    /// always shows that it is connected and Settings can disconnect the Mac.
    func autoShare() async {
        guard paired, !connected, !recording, !busy, !updateRequired else { return }
        if selection.isEmpty { selection = defaultSource()?.id ?? "" }
        guard !selection.isEmpty else { return }
        await pair()
    }
    func pair() async {
        toruLog.notice("share requested busy=\(self.busy) connected=\(self.connected) selection=\(self.selection.isEmpty ? "none" : "set", privacy: .public) paired=\(self.paired) code=\(self.code.isEmpty ? "empty" : "present", privacy: .public)")
        guard !busy && !connected && !recording && sources.contains(where: { $0.id == selection }) else { return }
        consent = true
        busy = true; defer { busy = false }
        do {
            endpoint = try validatedEndpoint()
            let pairWithCode: () async throws -> Void = { [self] in
                let result = try await post("pair", ["code": code.trimmingCharacters(in: .whitespacesAndNewlines), "persistent": true, "deviceName": "Mac"])
                guard let newToken = result["token"] as? String else { throw ToruError(message: "Invalid pairing response") }
                token = newToken
                guard result["mode"] as? String == "desktop" else { throw ToruError(message: "Ask your agent to use desktop_recording_pair for this Mac app.") }
                try remember(result)
            }
            if let existing = identity {
                do {
                    let renewed = try await post("device/refresh", ["refreshToken": existing.refreshToken])
                    try remember(renewed)
                    _ = try await post("device/resume")
                } catch let error as ToruHTTPError where error.status == 401 {
                    // The server no longer knows this Mac (revoked, erased or a different deployment). Drop the stale
                    // pairing so the code field reappears; pair immediately when a one-time code is already present.
                    toruLog.notice("saved pairing rejected by server; discarding it (code \(self.code.isEmpty ? "absent" : "present", privacy: .public))")
                    try? DeviceKeychain.remove(server: server); identity = nil; paired = false; token = nil
                    guard !code.isEmpty else { throw ToruError(message: "This Mac's saved pairing is no longer valid. Enter a new code from your agent or open a setup link, then share again.") }
                    try await pairWithCode()
                }
            } else {
                try await pairWithCode()
            }
            // Control follows the setting; which window it applies to is checked when the agent acts.
            _ = try await post("ready", ["captureConsent": true, "control": allowControl && DesktopControl.available])
            code = ""; connected = true; status = "Connected. Your agent can record \(selectedSourceName) whenever it needs to."
            let generation = UUID(); connectionGeneration = generation
            loop = Task { await self.poll(generation: generation) }
            scheduleRefresh(generation: generation)
        } catch { toruLog.error("pair failed: \(error.localizedDescription, privacy: .public)"); diagnose("pair_failed", error); status = error.localizedDescription; if token != nil { _ = try? await post("disconnect") }; token = nil }
    }
    private func transferPost(_ path: String, _ value: [String: Any] = [:], chunk: Data? = nil, offset: Int? = nil) async throws -> [String: Any] {
        // Upload endpoints are idempotent; capture commands are deliberately never retried here.
        for attempt in 0..<3 {
            try Task.checkCancellation()
            do { return try await post(path, value, chunk: chunk, offset: offset) }
            catch let error as URLError {
                if attempt == 2 || error.code == .cancelled { throw error }
                try await Task.sleep(for: .seconds(attempt + 1))
            }
        }
        throw ToruError(message: "Upload unavailable. Local video saved.")
    }
    private func upload(_ file: URL, capture: LocalCapture) async throws {
        guard let durationMs = capture.durationMs, durationMs > 0 else { throw ToruError(message: "Capture duration unavailable. Local video saved.") }
        let fingerprint = try await CaptureTransfer.fingerprint(file)
        let path = "desktop-upload/\(capture.id.uuidString.lowercased())/"
        let receipt = try await transferPost(path + "begin", ["bytes": fingerprint.bytes, "sha256": fingerprint.sha256,
            "media": ["width": capture.width, "height": capture.height, "durationMs": durationMs].merging(capture.layers.map { ["layers": $0.payload] } ?? [:]) { a, _ in a }])
        guard var offset = receipt["received"] as? Int, offset >= 0, offset <= fingerprint.bytes else { throw ToruError(message: "Invalid upload receipt") }
        while offset < fingerprint.bytes {
            try Task.checkCancellation()
            let count = min(4 * 1024 * 1024, fingerprint.bytes - offset)
            let chunk = try await CaptureTransfer.chunk(file, offset: offset, count: count)
            let result = try await transferPost(path + "chunk", chunk: chunk, offset: offset)
            guard let next = result["received"] as? Int, next >= offset + count, next <= fingerprint.bytes else { throw ToruError(message: "Invalid upload offset") }
            offset = next; status = "Uploading \(offset * 100 / fingerprint.bytes)%. Local video saved."
        }
        _ = try await transferPost(path + "complete")
    }
    func canRetry(_ entry: LocalCapture) -> Bool {
        !busy && !connected && !recording && entry.canRetry(server: server, device: identity?.deviceId)
    }
    func retryUpload(_ entry: LocalCapture) {
        guard canRetry(entry) else { return }
        busy = true; uploading = true
        retryTask = Task {
            defer { busy = false; uploading = false; retryTask = nil; token = nil }
            var savedEntry = entry
            do {
                guard let existing = identity, entry.canRetry(server: server, device: existing.deviceId) else {
                    throw ToruError(message: "Reconnect the Mac account that created this capture.")
                }
                endpoint = try validatedEndpoint()
                // Refresh identity only. No resume/ready command and no new capture consent.
                try remember(try await post("device/refresh", ["refreshToken": existing.refreshToken]))
                try Task.checkCancellation()
                let file = journal.file(for: entry)
                let duration = try await AVURLAsset(url: file).load(.duration).seconds
                guard duration.isFinite && duration > 0 else { throw ToruError(message: "Local capture is incomplete. Keep the file for recovery.") }
                savedEntry.stage = .uploading; try journal.save(savedEntry); recent = try journal.load()
                try await upload(file, capture: entry)
                try Task.checkCancellation()
                _ = try await transferPost("desktop-upload/\(entry.id.uuidString.lowercased())/publish")
                savedEntry.stage = .uploaded; try journal.save(savedEntry); recent = try journal.load()
                status = "Capture recovered. Ask your agent to render and export."
            } catch {
                diagnose("retry_upload_failed", error)
                savedEntry.stage = .saved; try? journal.save(savedEntry); recent = (try? journal.load()) ?? recent
                status = "Upload did not finish. Local video saved. \(error.localizedDescription)"
            }
        }
    }
    /// Classifies an error into a short code without any message text, titles or paths.
    static func errorCode(_ error: Error) -> String {
        if let http = error as? ToruHTTPError { return http.code ?? "http_\(http.status)" }
        let nsError = error as NSError
        if nsError.domain == SCStreamErrorDomain { return "scstream_\(abs(nsError.code))" }
        if nsError.domain == NSURLErrorDomain { return "url_\(abs(nsError.code))" }
        if error is ToruError { return "app_rule" }
        return "other"
    }
    private func diagnose(_ event: String, _ error: Error) {
        let code = Studio.errorCode(error); lastErrorCode = code
        guard diagnosticsOptIn, token != nil, endpoint != nil else { return }
        Task { _ = try? await post("diagnostics", ["event": event, "code": code, "appVersion": Studio.appVersion]) }
    }
    /// Scrubbed support bundle: versions, IDs, stages, sizes and timings. No video, titles, codes, credentials or paths.
    func supportBundle() -> String {
        let captures = recent.prefix(20).map { entry -> [String: Any] in
            ["id": entry.id.uuidString.lowercased(), "stage": entry.stage.rawValue, "createdAt": ISO8601DateFormatter().string(from: entry.createdAt),
             "durationMs": entry.durationMs ?? 0, "width": entry.width, "height": entry.height, "bound": entry.serverOrigin != nil]
        }
        let bundle: [String: Any] = ["appVersion": Studio.appVersion, "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "server": URL(string: server)?.host ?? "invalid", "paired": paired, "deviceIdPrefix": String(identity?.deviceId.prefix(8) ?? ""),
            "connected": connected, "recording": recording, "lastErrorCode": lastErrorCode, "captures": captures, "generatedAt": ISO8601DateFormatter().string(from: Date())]
        let data = (try? JSONSerialization.data(withJSONObject: bundle, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
    func copySupportBundle() {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(supportBundle(), forType: .string)
        status = "Support bundle copied. It contains versions, capture IDs, stages and timings only."
    }
    func recordNow() async {
        guard !busy && !connected && !recording && paired, let source = sources.first(where: { $0.id == selection }) else { return }
        consent = true
        busy = true; defer { busy = false }
        do {
            endpoint = try validatedEndpoint()
            guard let existing = identity else { throw ToruError(message: "Pair this Mac with your agent first.") }
            // Refresh identity only; the backend admits the capture with the same checks as an agent session.
            try remember(try await post("device/refresh", ["refreshToken": existing.refreshToken]))
            let begun = try await post("desktop-recording/begin", ["requestId": UUID().uuidString.lowercased()])
            guard let idString = begun["id"] as? String, let captureID = UUID(uuidString: idString) else { throw ToruError(message: "Invalid capture response") }
            guard try !journal.load().contains(where: { $0.id == captureID }) else { throw ToruError(message: "This capture already exists locally. It will not be overwritten.") }
            try FileManager.default.createDirectory(at: journal.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if let blocked = CaptureGuards.startBlocked(freeBytes: CaptureGuards.freeBytes(at: journal.directory)) { throw ToruError(message: blocked) }
            let entry = LocalCapture(id: captureID, createdAt: Date(), stage: .recording, width: source.width, height: source.height, serverOrigin: server, deviceId: identity?.deviceId)
            try journal.save(entry); current = entry; saved = nil
            try await capture.start(source, file: journal.file(for: entry))
            let generation = UUID(); connectionGeneration = generation
            manual = true; recordingSource = source.title; recording = true; status = "Recording \(source.title). Press Stop when done."
            watch(source: source, generation: generation)
            let limit = (begun["captureMs"] as? Int).map { Double($0) / 1000 } ?? 300
            timer = Task { try? await Task.sleep(for: .seconds(limit)); if !Task.isCancelled { await self.stop(message: "Recording limit reached. Saving and uploading.") } }
        } catch {
            diagnose("manual_start_failed", error)
            if current?.stage == .recording { try? stage(.interrupted) }
            current = nil; consent = false; token = nil
            status = error.localizedDescription
        }
    }
    /// Single Stop for buttons, menu bar and the keyboard shortcut.
    func stop(message: String? = nil) async {
        if manual { await stopManual(message: message) } else { await disconnect(message: message ?? "Disconnected. Local videos remain on this Mac.") }
    }
    private func stopManual(message: String?) async {
        guard manual, manualTask == nil else { return }
        connectionGeneration = UUID()
        let task = Task { [self] in
            do {
                status = message ?? "Saving…"
                let file = try await finalize()
                try stage(.uploading); uploading = true; status = "Uploading. Local video saved."
                guard let entry = current else { throw ToruError(message: "Capture identity unavailable") }
                try await upload(file, capture: entry)
                try Task.checkCancellation()
                _ = try await transferPost("desktop-upload/\(entry.id.uuidString.lowercased())/publish")
                try stage(.uploaded)
                status = "Uploaded. Ask your agent to render it, or open your Toru library."
            } catch {
                diagnose("manual_stop_failed", error)
                if current?.stage == .uploading { try? stage(.saved) }
                if current?.stage == .recording || current?.stage == .finalizing { try? stage(.interrupted) }
                status = "Upload did not finish. Local video saved; use Retry upload. \(error.localizedDescription)"
            }
            manual = false; recording = false; uploading = false; current = nil; consent = false; token = nil
        }
        manualTask = task
        await task.value
        manualTask = nil
    }
    func cancelUpload() async {
        guard uploading else { return }
        await disconnect(message: "Upload canceled. Local video saved; accepted cloud bytes may remain until retention expires.")
    }
    func canManageLocal(_ entry: LocalCapture) -> Bool {
        !busy && !uploading && current?.id != entry.id && ![.recording, .finalizing, .uploading].contains(entry.stage)
    }
    func playLocal(_ entry: LocalCapture) {
        guard canManageLocal(entry) else { return }
        if !NSWorkspace.shared.open(journal.file(for: entry)) { status = "Could not open the local video. Use Show in Finder to inspect it." }
    }
    func deleteLocal(_ entry: LocalCapture) async {
        guard canManageLocal(entry) else { return }
        busy = true; defer { busy = false }
        do {
            let file = journal.file(for: entry)
            if FileManager.default.fileExists(atPath: file.path) {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    NSWorkspace.shared.recycle([file]) { _, error in
                        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                    }
                }
            }
            try journal.removeManifest(for: entry)
            recent = try journal.load()
            if saved == file { saved = nil }
            status = "Local copy moved to Trash. Cloud recordings are unchanged."
        } catch { status = "Could not remove the local copy. \(error.localizedDescription)" }
    }
    private func remember(_ response: [String: Any]) throws {
        let next = try JSONDecoder().decode(DeviceIdentity.self, from: JSONSerialization.data(withJSONObject: response))
        // Set the live token first so a storage error can still disconnect the new lease.
        token = next.accessToken
        try DeviceKeychain.save(next, server: server)
        identity = next; paired = true
    }
    func forgetDevice() async {
        await disconnect()
        busy = true; defer { busy = false }
        endpoint = URL(string: server)
        var remotelyRevoked = identity == nil
        if let existing = identity {
            do {
                token = existing.accessToken
                if existing.accessExpiresAt <= Date().timeIntervalSince1970 * 1000 {
                    try remember(try await post("device/refresh", ["refreshToken": existing.refreshToken]))
                }
                _ = try await post("device/revoke")
                remotelyRevoked = true
            } catch { remotelyRevoked = false }
        }
        do {
            try DeviceKeychain.remove(server: server)
            identity = nil; paired = false; token = nil
            status = remotelyRevoked ? "Mac disconnected. Ask your agent for a new pairing code." : "Credential removed from this Mac. Remote revocation failed; ask your agent to use desktop_device_disconnect."
        } catch { token = nil; status = error.localizedDescription }
    }
    private func poll(generation: UUID) async {
        do {
            while connected && connectionGeneration == generation && !Task.isCancelled {
                let response = try await post("poll")
                try Task.checkCancellation()
                guard connected && connectionGeneration == generation else { return }
                guard let command = response["command"] as? [String: Any] else { continue }
                guard let id = command["id"] as? String, UUID(uuidString: id) != nil, let method = command["method"] as? String else { throw ToruError(message: "Invalid command") }
                var result: Any = NSNull()
                do {
                    switch method {
                    case "currentUrl": result = controlReady ? ((try? desktopControl().handle("currentUrl", [])) ?? "https://toru.tools") : "https://toru.tools"
                    case "startRecording":
                        guard var source = sources.first(where: { $0.id == selection }) else { throw ToruError(message: "Source unavailable") }
                        guard consent && current == nil else { throw ToruError(message: "Approve a new recording in Toru first.") }
                        let arguments = command["args"] as? [[String: Any]]
                        // A server that knows window presets names one (1920x1080 by default); older ones send none.
                        let windowSize = (arguments?.first?["windowSize"] as? String).flatMap { WindowSizing.presets[$0] == nil ? nil : $0 }
                        let captureID = (arguments?.first?["captureId"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID()
                        guard try !journal.load().contains(where: { $0.id == captureID }) else { throw ToruError(message: "This capture already exists locally. It will not be overwritten.") }
                        try FileManager.default.createDirectory(at: journal.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                        if let blocked = CaptureGuards.startBlocked(freeBytes: CaptureGuards.freeBytes(at: journal.directory)) { throw ToruError(message: blocked) }
                        let serverCapture = (arguments?.first?["captureId"] as? String).flatMap(UUID.init(uuidString:))
                        let entry = LocalCapture(id: captureID, createdAt: Date(), stage: .recording, width: source.width, height: source.height,
                                                 serverOrigin: serverCapture == nil ? nil : server, deviceId: serverCapture == nil ? nil : identity?.deviceId)
                        try journal.save(entry); current = entry; saved = nil
                        let operated = controlReady ? try? desktopControl() : nil
                        windowReport = nil
                        do {
                            if let windowSize {
                                // In front first: a window manager that parks windows of other workspaces off screen
                                // brings it back where it will be recorded, and the size is fitted to that screen.
                                operated?.beginRecording(at: Date())
                                source = await sizeWindow(source, preset: windowSize, operated: operated)
                            }
                            capture.showsCursor = operated == nil
                            // Telemetry lines up with the recording that starts now.
                            operated?.beginRecording(at: Date())
                            try await capture.start(source, file: journal.file(for: entry))
                            if let id = source.windowIDs.first, let window = AccessibilityOutline.bounds(of: id) { operated?.place(window: window, region: capture.region) }
                            try Task.checkCancellation()
                            guard connected && consent && connectionGeneration == generation else { throw CancellationError() }
                        } catch {
                            // The recording did not start: the window gets its own size back now.
                            await restoreWindow()
                            throw error
                        }
                        recordingSource = source.title; recording = true; status = "Recording \(source.title)"
                        watch(source: source, generation: generation)
                        timer = Task { try? await Task.sleep(for: .seconds(300)); if !Task.isCancelled { await self.disconnect(message: "Five-minute limit reached. Local capture saved.") } }
                    case "stopRecording":
                        status = "Saving…"
                        control?.endRecording()
                        let file = try await finalize()
                        try Task.checkCancellation()
                        guard connected && connectionGeneration == generation else { throw CancellationError() }
                        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                        guard size > 0 && size <= 256 * 1024 * 1024 else { throw ToruError(message: "Capture exceeds upload limit. Local file saved.") }
                        try stage(.uploading); uploading = true; status = "Uploading. Local video saved."
                        do {
                            guard let entry = current else { throw ToruError(message: "Capture identity unavailable") }
                            try await upload(file, capture: entry)
                        } catch {
                            uploading = false
                            try stage(.saved)
                            throw error
                        }
                        uploading = false
                        result = ["body": "desktop_upload", "captureId": current?.id.uuidString.lowercased() ?? "", "contentType": "video/mp4", "redactionPassed": false]
                    case "listSources":
                        // The agent asks what it may record; refreshing never changes the current selection on its own.
                        if !recording { await refresh() }
                        result = ["sources": sources.map { ["id": $0.id, "title": $0.title, "kind": $0.id.hasPrefix("display-") ? "display" : "window", "width": $0.width, "height": $0.height, "selected": $0.id == selection] },
                                  "selected": (selection.isEmpty ? NSNull() : selection) as Any]
                    case "selectSource":
                        guard !recording else { throw ToruError(message: "Cannot change the source while recording.") }
                        let wanted = ((command["args"] as? [[String: Any]])?.first?["sourceId"] as? String) ?? ""
                        if sources.isEmpty || !sources.contains(where: { $0.id == wanted }) { await refresh() }
                        guard let source = sources.first(where: { $0.id == wanted }) ?? sources.first(where: { $0.title.localizedCaseInsensitiveContains(wanted) }) else {
                            throw ToruError(message: "Source not found. Ask for the list again.")
                        }
                        selection = source.id
                        toruLog.notice("agent selected source \(source.id, privacy: .public)")
                        result = ["selected": source.id, "title": source.title, "width": source.width, "height": source.height]
                    case "screenshot" where saved == nil && allowControl:
                        // While Toru operates the window, the navigator looks at it after each step.
                        guard let source = selectedSource else { throw ToruError(message: "Source unavailable") }
                        let config = SCStreamConfiguration()
                        config.width = source.width; config.height = source.height; config.showsCursor = false
                        let image = try await SCScreenshotManager.captureImage(contentFilter: source.filter, configuration: config)
                        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw ToruError(message: "Screenshot unavailable") }
                        result = ["body": ["$bytes": png.base64EncodedString()], "contentType": "image/png", "redactionPassed": false]
                    case "screenshot":
                        guard let file = saved else { throw ToruError(message: "Preview is available after recording stops.") }
                        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
                        generator.appliesPreferredTrackTransform = true
                        let (image, _) = try await generator.image(at: .zero)
                        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw ToruError(message: "Preview unavailable") }
                        result = ["body": ["$bytes": png.base64EncodedString()], "contentType": "image/png", "redactionPassed": false]
                    case "markDemoMoment": break // Cursor is captured natively; no synthetic overlays in this preview.
                    case "readPage", "pageText", "pointer", "gesture", "formInput", "typeText", "pressKey", "scrollBy", "redactSensitiveText":
                        let operated = try desktopControl()
                        let arguments = command["args"] as? [Any] ?? []
                        result = try await Task.detached { try operated.handle(method, arguments) }.value
                    case "dispose":
                        control?.endRecording()
                        if recording { _ = try await finalize() }
                    default: throw ToruError(message: "Desktop preview supports capture only.")
                    }
                    let operated = control.flatMap { _ in controlReady ? control : nil }?.telemetry()
                    var meta: [String: Any] = ["captureViewport": ["width": capture.width, "height": capture.height], "recordingMode": "screencast", "recordingElapsedMs": capture.durationMs > 0 ? capture.durationMs : max(0, Int((capture.started.map { Date().timeIntervalSince($0) } ?? 0)*1000)),
                                               "pointerTrail": operated?.trail ?? [], "pointerTelemetry": operated?.pointer ?? [], "semanticTimeline": operated?.timeline ?? [],
                                               "identitySightings": operated?.identity ?? []]
                    // The shared window's size for this recording (points), whether Toru resized it, and why not.
                    if let windowReport { meta["desktopWindow"] = windowReport.payload }
                    try Task.checkCancellation()
                    guard connected && connectionGeneration == generation else { throw CancellationError() }
                    _ = try await post("result/\(id)", ["value": result, "meta": meta])
                    if method == "stopRecording" {
                        try stage(.uploaded)
                        status = "Uploaded. Ask your agent to render and export."
                    }
                } catch {
                    diagnose("command_failed", error)
                    FileHandle.standardError.write("toru command \(method) failed: \(error.localizedDescription)\n".data(using: .utf8)!)
                    // A control step that misses (a stale element, a field that refuses text) is reported to the navigator,
                    // which decides the next step; the share and the recording continue. Capture failures still end the share.
                    if DesktopControl.methods.contains(method) {
                        let message = error.localizedDescription
                        let code = message.hasPrefix("local_sign_in_required") ? "local_sign_in_required" : message.hasPrefix("local_method_forbidden") ? "local_method_forbidden" : "local_browser_action_failed"
                        if connectionGeneration == generation { _ = try? await post("result/\(id)", ["error": code]) }
                        continue
                    }
                    if connectionGeneration == generation { _ = try? await post("result/\(id)", ["error": "local_browser_action_failed"]) }
                    throw error
                }
                if method == "dispose" {
                    // The share continues: keep polling for the next recording until the user stops sharing.
                    current = nil; saved = nil; timer?.cancel(); recording = false; uploading = false; windowReport = nil
                    status = "Capture delivered. Still shared with your agent; press Stop sharing when you are done."
                }
            }
        } catch {
            guard connected && connectionGeneration == generation else { return }
            let transient = error is URLError || (error as? ToruHTTPError)?.transient == true
            await disconnect(message: transient ? "Toru is unreachable for a moment. Reconnecting…" : error.localizedDescription)
            if transient { scheduleReconnect() }
        }
    }
    /// A server restart or a network drop ends the poll. A paired Mac shares again by itself, with growing pauses,
    /// instead of waiting for a click; Stop sharing, Disconnect or a recording cancels it.
    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            for attempt in 0... {
                try? await Task.sleep(for: .seconds([2, 5, 10, 20, 30, 60][min(attempt, 5)]))
                guard let self, !Task.isCancelled, self.paired, !self.connected, !self.recording else { return }
                await self.autoShare()
                if self.connected { return }
            }
        }
    }
    /// The shared window's frame before Toru resized it for the current recording, put back when it ends.
    private var windowUndo: WindowResize?
    /// What happened to the shared window for the current recording, reported as capture metadata (desktopWindow).
    private var windowReport: WindowSizing.Report?

    /// Gives the shared window the preset size the agent asked for, when the user lets their agent operate it.
    /// Otherwise (control off, a display, a window that refuses a new size) records as is and says why.
    /// Returns the source as it is now, with its new size.
    private func sizeWindow(_ source: CaptureSource, preset: String, operated: DesktopControl?) async -> CaptureSource {
        guard let windowID = source.windowIDs.first else {
            windowReport = WindowSizing.Report(requested: preset, width: source.width, height: source.height, resized: false, reason: .display)
            return source
        }
        guard let operated else {
            let bounds = AccessibilityOutline.bounds(of: windowID)
            windowReport = WindowSizing.Report(requested: preset, width: Int(bounds?.width ?? CGFloat(source.width)), height: Int(bounds?.height ?? CGFloat(source.height)),
                                               resized: false, reason: .controlOff)
            return source
        }
        let screens = WindowResize.screenFrames(), pid = operated.pid
        let (report, undo) = await Task.detached { WindowResize.apply(preset: preset, windowID: windowID, pid: pid, screens: screens) }.value
        windowReport = report; windowUndo = undo
        toruLog.notice("window preset \(preset, privacy: .public): \(report.width)x\(report.height) resized=\(report.resized) \(report.reason?.rawValue ?? "", privacy: .public)")
        return report.resized ? await resized(source) : source
    }
    /// Puts the shared window back as it was before the recording; a no-op when Toru did not resize it.
    private func restoreWindow() async {
        guard let undo = windowUndo else { return }
        windowUndo = nil
        let restored = await Task.detached { undo.restore() }.value
        windowReport?.restored = restored
        toruLog.notice("window restored=\(restored)")
        if let source = sources.first(where: { $0.windowIDs.first == undo.windowID }) { _ = await resized(source) }
    }
    /// The listed source with its window's current size and a fresh filter, so screenshots and the list match it.
    private func resized(_ source: CaptureSource) async -> CaptureSource {
        guard let id = source.windowIDs.first,
              let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false),
              let window = content.windows.first(where: { $0.windowID == id }) else { return source }
        var updated = CaptureSource(id: source.id, title: source.title, filter: SCContentFilter(desktopIndependentWindow: window),
                                    width: Int(window.frame.width), height: Int(window.frame.height), windowIDs: source.windowIDs)
        updated.displayIDs = source.displayIDs
        if let index = sources.firstIndex(where: { $0.id == source.id }) { sources[index] = updated }
        return updated
    }
    private func stage(_ stage: LocalCapture.Stage) throws {
        guard var entry = current else { return }
        entry.stage = stage; entry.durationMs = capture.durationMs > 0 ? capture.durationMs : nil
        entry.width = capture.width; entry.height = capture.height
        if capture.region != nil, !capture.layers.samples.isEmpty { entry.layers = capture.layers }
        try journal.save(entry); current = entry; recent = try journal.load()
    }
    private func finalize() async throws -> URL {
        timer?.cancel(); watchdog?.cancel()
        // Journal failure must never prevent stopping screen capture.
        let journalError: Error?
        do { try stage(.finalizing); journalError = nil } catch { journalError = error }
        do {
            let file = try await capture.stop()
            // The window gets its own size back once the capture has stopped, so the video never shows it snap back.
            await restoreWindow()
            // Each recording needs a new approval, unless the user lets their agent operate the shared window:
            // then the share stays approved for the agent's next recording until they press Stop sharing.
            recording = false; saved = file; consent = allowControl && connected
            try stage(.saved)
            if let journalError { throw journalError }
            return file
        } catch {
            await restoreWindow()
            recording = false; consent = false
            try? stage(.interrupted)
            throw error
        }
    }
    func disconnect(message: String = "Disconnected. Local videos remain on this Mac.") async {
        guard !disconnecting else { return }
        // Why the Mac let go, next to the control log: a run that drops right after it starts is otherwise silent.
        FileHandle.standardError.write("toru: disconnected: \(message)\n".data(using: .utf8)!)
        disconnecting = true; busy = true
        defer { busy = false; disconnecting = false }
        reconnectTask?.cancel()
        connectionGeneration = UUID()
        retryTask?.cancel()
        await retryTask?.value
        manualTask?.cancel()
        await manualTask?.value
        manual = false
        connected = false; consent = false; loop?.cancel(); timer?.cancel(); watchdog?.cancel(); refreshTask?.cancel()
        var finalMessage = message
        if capture.stream != nil {
            do { _ = try await finalize() }
            catch { finalMessage += " Capture was interrupted; check Movies/Toru." }
        }
        // Also when the recording never started (a failed start, a canceled command).
        await restoreWindow()
        windowReport = nil
        if current?.stage == .uploading { try? stage(.saved) }
        if current?.stage == .recording || current?.stage == .finalizing { try? stage(.interrupted) }
        recording = false
        uploading = false
        if token != nil {
            // Often called from a task that this method just cancelled (watchdog, limit timer); the server must still hear it.
            let notify = Task { [self] in try await post("disconnect") }
            do { _ = try await notify.value; toruLog.notice("disconnect acknowledged by server") }
            catch { toruLog.error("disconnect not delivered: \(error.localizedDescription, privacy: .public)") }
        } else { toruLog.notice("disconnect skipped: no session token") }
        token = nil; current = nil; status = finalMessage
        Task { await checkForUpdate() }
    }
}

struct StudioView: View {
    @ObservedObject var studio: Studio
    @Environment(\.openWindow) private var openWindow
    @State private var deleteCandidate: LocalCapture?
    private var canShare: Bool { !(studio.connected || studio.busy || studio.recording || studio.updateRequired || studio.selection.isEmpty || (!studio.paired && studio.code.isEmpty)) }
    private var canRecordNow: Bool { !(studio.connected || studio.busy || studio.recording || studio.updateRequired || studio.selection.isEmpty || !studio.paired) }
    private var sourceName: String {
        guard let source = studio.selectedSource else { return "this source" }
        if source.id.hasPrefix("display-") { return "Display \(source.id.dropFirst("display-".count))" }
        return source.title.components(separatedBy: " — ").first ?? source.title
    }
    @State private var page = 0
    private let pageSize = 5
    private var windows: [CaptureSource] { studio.sources.filter { !$0.id.hasPrefix("display-") } }
    private var displays: [CaptureSource] { studio.sources.filter { $0.id.hasPrefix("display-") } }
    var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: 248).studioCard().padding(.leading, 12).padding(.vertical, 12)
            main.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 920, minHeight: 640).background(StudioGround()).tint(Theme.accent)
        .alert("Move this recording to the Trash?", isPresented: Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }), presenting: deleteCandidate) { item in
            Button("Move to Trash", role: .destructive) { Task { await studio.deleteLocal(item) }; deleteCandidate = nil }
            Button("Keep", role: .cancel) { deleteCandidate = nil }
        } message: { _ in Text("This may be the only copy on this Mac. Recordings already in your Toru library are not affected.") }
    }

    // MARK: Sidebar — identity, account, sources
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) { LensMark(size: 22); Text("toru").font(Theme.sans(19, .medium)).kerning(-1.1).foregroundStyle(Theme.ink) }
                .padding(.top, 34).padding(.horizontal, 18).padding(.bottom, 18)
            accountCard.padding(.horizontal, 10).padding(.bottom, 18)
            HStack(alignment: .firstTextBaseline) {
                Text("What to record").font(Theme.sans(13, .medium)).foregroundStyle(Theme.ink)
                Spacer()
                Button { Task { await studio.refresh() } } label: { Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted) }
                    .buttonStyle(.plain).help("Refresh the list").accessibilityLabel("Refresh").disabled(studio.connected || studio.busy)
            }.padding(.horizontal, 18).padding(.bottom, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if studio.sources.isEmpty {
                        Text("No windows listed").font(Theme.sans(12)).foregroundStyle(Theme.muted).padding(.horizontal, 8).padding(.top, 4).help("Refresh, or choose a window with the system picker.")
                    }
                    if !windows.isEmpty {
                        Text("Windows").font(Theme.sans(11, .medium)).foregroundStyle(Theme.muted).padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 2)
                        ForEach(windows) { source in SourceRow(source: source, selected: source.id == studio.selection) { studio.selection = source.id } }
                    }
                    if !displays.isEmpty {
                        Text("Displays").font(Theme.sans(11, .medium)).foregroundStyle(Theme.muted).padding(.horizontal, 10).padding(.top, 14).padding(.bottom, 2)
                        ForEach(displays) { source in SourceRow(source: source, selected: source.id == studio.selection) { studio.selection = source.id } }
                    }
                }.padding(.horizontal, 8)
            }
            .disabled(studio.connected || studio.busy || studio.recording).accessibilityLabel("Sources")
            Button("Choose another window…") { studio.chooseSource() }.buttonStyle(GlassPillButtonStyle()).controlSize(.small)
                .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 14)
                .disabled(studio.connected || studio.busy || studio.recording).accessibilityLabel("Choose window or display")
            Rectangle().fill(Theme.hair).frame(height: 1).padding(.horizontal, 10)
            HStack {
                SettingsLink {
                    HStack(spacing: 6) { Image(systemName: "gearshape").font(.system(size: 12, weight: .medium)); Text("Settings").font(Theme.sans(12, .medium)) }.foregroundStyle(Theme.muted)
                }.buttonStyle(.plain).accessibilityLabel("Settings")
                Spacer()
                Text("\(Studio.appVersion) beta").font(Theme.sans(11)).foregroundStyle(Theme.faint)
            }.padding(.horizontal, 18).padding(.vertical, 12)
        }
    }

    private var accountCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if studio.paired {
                HStack(spacing: 8) {
                    ZStack {
                        Circle().fill((studio.recording ? Theme.recording : studio.connected ? Theme.ready : Theme.muted).opacity(0.14)).frame(width: 20, height: 20)
                        Circle().fill(studio.recording ? Theme.recording : studio.connected ? Theme.ready : Theme.faint).frame(width: 7, height: 7)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(studio.recording ? "Recording" : studio.connected ? "Connected" : "Paired, not shared").font(Theme.sans(13, .medium)).foregroundStyle(Theme.ink)
                        Text(URL(string: studio.server)?.host ?? studio.server).font(Theme.sans(11)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    Spacer()
                }
            } else {
                Text("Pair this Mac").font(Theme.sans(13, .medium)).foregroundStyle(Theme.ink)
                TextField("Server", text: $studio.server).textFieldStyle(PaleFieldStyle()).disabled(studio.connected || studio.busy)
                SecureField("One-time code", text: $studio.code).textFieldStyle(PaleFieldStyle()).disabled(studio.connected || studio.busy)
                Text("From your agent or Connections in the Toru console").font(Theme.sans(11)).foregroundStyle(Theme.muted).help("Ask your agent for desktop_recording_pair, or open Connections → Pair a Mac in the console.")
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.window))
    }

    // MARK: Main — preview, approval, action, library
    private var main: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text(studio.recording ? "Recording" : studio.connected ? "Shared with your agent until you stop" : "Record a window").font(Theme.sans(24)).kerning(-0.7).foregroundStyle(Theme.ink)
                    .padding(.top, 34)
                    .help("Choose what your agent may capture, then share it. Nothing is recorded or uploaded without that click.")
                UpdateBanner(studio: studio)
                PreviewStage(studio: studio)
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 10) {
                        if studio.connected || studio.recording {
                            Button(studio.manual ? "Stop and upload" : "Stop sharing") { Task { await studio.stop() } }.buttonStyle(InkPillButtonStyle()).accessibilityLabel("Stop")
                            if studio.uploading { Button("Cancel upload") { Task { await studio.cancelUpload() } }.buttonStyle(QuietButtonStyle(color: Theme.danger)) }
                        } else {
                            Button(studio.busy ? "Connecting…" : "Share \(sourceName) with my agent") { Task { await studio.pair() } }.buttonStyle(InkPillButtonStyle()).disabled(!canShare).accessibilityLabel("Share selected source")
                                .help("Lets your agent record \(sourceName) as many times as needed until you press Stop sharing. Each video is uploaded to Toru when it stops.")
                            Button("Record now") { Task { await studio.recordNow() } }.buttonStyle(GlassPillButtonStyle()).disabled(!canRecordNow).accessibilityLabel("Record now")
                                .help("Record it yourself with the same account and credits, then ask your agent to render it.")
                        }
                    }
                    HStack(alignment: .top, spacing: 8) {
                        Circle().fill(studio.recording ? Theme.recording : studio.connected ? Theme.ready : Theme.faint).frame(width: 7, height: 7).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(studio.shareBlocker.map { !studio.connected && !studio.recording ? $0 : studio.status } ?? studio.status).font(Theme.sans(13)).foregroundStyle(Theme.ink).textSelection(.enabled)
                        }
                    }.frame(maxWidth: 560, alignment: .leading)
                }
                if !studio.recent.isEmpty {
                    let total = studio.recent.count, pages = max(1, (total + pageSize - 1) / pageSize), current = min(page, pages - 1)
                    let slice = Array(studio.recent.dropFirst(current * pageSize).prefix(pageSize))
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .firstTextBaseline) {
                            Text("On this Mac").font(Theme.sans(15, .medium)).kerning(-0.2).foregroundStyle(Theme.ink).help("Local copies. Your library in Toru is separate and follows your plan's retention.")
                            Spacer()
                            if pages > 1 {
                                HStack(spacing: 10) {
                                    Button { page = max(0, current - 1) } label: { Image(systemName: "chevron.left").font(.system(size: 11, weight: .semibold)) }.buttonStyle(.plain).foregroundStyle(current == 0 ? Theme.line : Theme.ink).disabled(current == 0).accessibilityLabel("Previous page")
                                    Text("\(current * pageSize + 1)–\(min(total, (current + 1) * pageSize)) of \(total)").font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.muted)
                                    Button { page = min(pages - 1, current + 1) } label: { Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)) }.buttonStyle(.plain).foregroundStyle(current >= pages - 1 ? Theme.line : Theme.ink).disabled(current >= pages - 1).accessibilityLabel("Next page")
                                }
                            }
                        }.frame(maxWidth: 760)
                        VStack(spacing: 0) {
                            ForEach(Array(slice.enumerated()), id: \.element.id) { index, item in
                                RecordingRow(studio: studio, item: item, delete: { deleteCandidate = item })
                                if index < slice.count - 1 { Rectangle().fill(Theme.hair).frame(height: 1).padding(.leading, 96) }
                            }
                        }
                        .frame(maxWidth: 760)
                        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous)).studioCard()
                    }.padding(.bottom, 32)
                }
            }.padding(.horizontal, 32).frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct SourceRow: View {
    let source: CaptureSource
    let selected: Bool
    let choose: () -> Void
    @State private var hovering = false
    private var isDisplay: Bool { source.id.hasPrefix("display-") }
    private var parts: (String, String) {
        if isDisplay { return ("Display \(source.id.dropFirst("display-".count))", "Everything on this screen") }
        let pieces = source.title.components(separatedBy: " — ")
        return pieces.count > 1 ? (pieces[0], pieces.dropFirst().joined(separator: " — ")) : (source.title, "Window")
    }
    var body: some View {
        Button(action: choose) {
            HStack(spacing: 10) {
                Image(systemName: isDisplay ? "display" : "macwindow").font(.system(size: 13)).foregroundStyle(selected ? Theme.ink : Theme.faint).frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(parts.0).font(Theme.sans(13, selected ? .medium : .regular)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(parts.1).font(Theme.sans(11)).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.ink) }
            }
            .padding(.horizontal, 10).padding(.vertical, 7).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(selected ? Theme.selected : hovering ? Theme.window : Color.clear))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }.buttonStyle(.plain).onHover { hovering = $0 }.accessibilityLabel(source.title).help(source.title)
    }
}

/// The one bold element: what will be recorded, as it looks right now.
struct PreviewStage: View {
    @ObservedObject var studio: Studio
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 13, style: .continuous).fill(Theme.window).padding(8)
            if let preview = studio.preview, !studio.recording {
                Image(nsImage: preview).resizable().aspectRatio(contentMode: .fit).padding(22)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .shadow(color: Theme.shadow.opacity(0.16), radius: 14, y: 6)
            } else if studio.recording {
                VStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Theme.recording.opacity(0.12)).frame(width: 84, height: 84)
                        Circle().fill(Theme.recording).frame(width: 16, height: 16)
                    }
                    CaptureIndicator(studio: studio)
                }
            } else if studio.selectedSource != nil {
                ProgressView().controlSize(.small)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "rectangle.dashed").font(.system(size: 28, weight: .light)).foregroundStyle(Theme.muted)
                    Text("Select a window or display on the left").font(Theme.sans(13)).foregroundStyle(Theme.muted)
                }
            }
            if let source = studio.selectedSource, !studio.recording {
                VStack { Spacer(); HStack {
                    Text(source.title).font(Theme.sans(12, .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer()
                    Text("\(String(source.width))×\(String(source.height))").font(Theme.sans(11)).foregroundStyle(Theme.muted).help("Video and cursor only. No audio, no control of your Mac.")
                }.padding(.horizontal, 16).padding(.vertical, 10).background(.white) }
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
        }
        .frame(maxWidth: 760).frame(height: 380)
        .studioCard()
        .accessibilityHidden(true)
    }
}

struct RecordingRow: View {
    @ObservedObject var studio: Studio
    let item: LocalCapture
    let delete: () -> Void
    @State private var hovering = false
    private var state: (String, Color) {
        switch item.stage {
        case .uploaded: return ("In your library", Theme.ready)
        case .saved: return (item.serverOrigin != nil ? "Not uploaded" : "Saved", Theme.muted)
        case .interrupted: return ("Interrupted", Theme.danger)
        case .uploading: return ("Uploading", Theme.accent)
        case .recording, .finalizing: return ("Recording", Theme.recording)
        }
    }
    private var duration: String {
        guard let ms = item.durationMs, ms > 0 else { return "—" }
        let seconds = ms / 1000
        return seconds >= 60 ? "\(seconds / 60) min \(seconds % 60) s" : "\(seconds) s"
    }
    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.window)
                if let image = studio.thumbnails[item.id] {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
                } else {
                    Image(systemName: "film").font(.system(size: 14)).foregroundStyle(Theme.muted)
                }
            }
            .frame(width: 66, height: 42).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(Theme.line, lineWidth: 1))
            .task(id: item.id) { await studio.thumbnail(for: item) }
            VStack(alignment: .leading, spacing: 3) {
                Text(item.createdAt.formatted(date: .abbreviated, time: .shortened)).font(Theme.sans(13, .medium)).foregroundStyle(Theme.ink)
                HStack(spacing: 6) {
                    Text(state.0).font(Theme.sans(11, .medium)).foregroundStyle(state.1)
                    Text("·").foregroundStyle(Theme.line)
                    Text("\(duration) · \(String(item.width))×\(String(item.height))").font(Theme.sans(11)).foregroundStyle(Theme.muted)
                }
            }
            Spacer()
            HStack(spacing: 12) {
                if studio.canRetry(item) { Button("Retry upload") { studio.retryUpload(item) }.buttonStyle(GlassPillButtonStyle()).controlSize(.small).accessibilityLabel("Retry upload").help("Retry upload: send this recording to Toru again.") }
                Button("Play") { studio.playLocal(item) }.buttonStyle(QuietButtonStyle()).disabled(!studio.canManageLocal(item))
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([studio.journal.file(for: item)]) }.buttonStyle(QuietButtonStyle())
                Button("Delete") { delete() }.buttonStyle(QuietButtonStyle(color: Theme.danger)).disabled(!studio.canManageLocal(item))
            }.opacity(hovering || studio.canRetry(item) ? 1 : 0.55)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(hovering ? Theme.window : Color.white)
        .onHover { hovering = $0 }
    }
}

struct SettingsView: View {
    @ObservedObject var studio: Studio
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 8) { LensMark(size: 20); Text("Settings").font(Theme.sans(20)).kerning(-0.5).foregroundStyle(Theme.ink) }
            SettingsGroup(title: "Account") {
                SettingsRow(title: studio.paired ? "Paired with \(URL(string: studio.server)?.host ?? studio.server)" : "Not paired", detail: studio.paired ? "Your agent can record the shared source. Disconnecting requires a new setup link to record again." : "Open a setup link from your agent or from Connections in the Toru console.") {
                    if studio.paired { Button("Disconnect this Mac") { Task { await studio.forgetDevice() } }.buttonStyle(GlassPillButtonStyle()).controlSize(.small).disabled(studio.busy).accessibilityLabel("Disconnect Mac") }
                }
            }
            SettingsGroup(title: "Privacy") {
                SettingsRow(title: "Send failure reports", detail: "Event name, error code and app version. Never video, titles, codes or credentials.") {
                    Toggle("", isOn: $studio.diagnosticsOptIn).labelsHidden().toggleStyle(.switch)
                }
                SettingsRow(title: "Trash uploaded copies after 30 days", detail: "Only copies already in your library. Saved or interrupted recordings stay.") {
                    Toggle("", isOn: $studio.autoTrashUploaded).labelsHidden().toggleStyle(.switch)
                }
            }
            SettingsGroup(title: "Recording") {
                SettingsRow(title: "Floating bar", detail: "The compact bar with connection, source, Share and Record. Never part of the capture.") {
                    Toggle("", isOn: $studio.showHUD).labelsHidden().toggleStyle(.switch)
                }
                SettingsRow(title: "Let your agent operate the shared window", detail: DesktopControl.available || !studio.allowControl
                            ? "During recordings your agent asks for, Toru clicks and types in the shared window in the background, without your mouse or keyboard. Terminals, password managers and System Settings are never operated."
                            : "Allow Toru in System Settings → Privacy & Security → Accessibility, then share again.") {
                    Toggle("", isOn: $studio.allowControl).labelsHidden().toggleStyle(.switch).accessibilityLabel("Let your agent operate the shared window")
                }
            }
            SettingsGroup(title: "App") {
                SettingsRow(title: "Toru \(Studio.appVersion)", detail: "Checks once a day and after each recording.") {
                    Button("Check for updates") { Task { await studio.checkForUpdate(force: true) } }.buttonStyle(GlassPillButtonStyle()).controlSize(.small)
                }
                SettingsRow(title: "Support bundle", detail: "Versions, capture IDs, stages and timings, copied to the clipboard.") {
                    Button("Copy") { studio.copySupportBundle() }.buttonStyle(GlassPillButtonStyle()).controlSize(.small)
                }
                SettingsRow(title: "Demo window", detail: "A synthetic window to try a recording.") {
                    Button("Open") { openWindow(id: "demo") }.buttonStyle(GlassPillButtonStyle()).controlSize(.small)
                }
            }
        }
        .padding(28).frame(width: 520).background(StudioGround()).tint(Theme.accent)
    }
}
struct SettingsGroup<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Theme.sans(12.5)).foregroundStyle(Theme.muted).padding(.leading, 4)
            VStack(spacing: 0) { content }.studioCard()
        }
    }
}
struct SettingsRow<Accessory: View>: View {
    let title: String
    let detail: String
    @ViewBuilder let accessory: Accessory
    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.ink)
                Text(detail).font(Theme.sans(11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            accessory
        }.padding(.horizontal, 14).padding(.vertical, 10)
    }
}
struct DemoView: View {
    @State private var items = 0
    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            Text("toru / capture test").font(.title).bold()
            Text("A native Mac window, recorded through MCP.").font(.title2)
            TimelineView(.animation) { context in
                let phase = context.date.timeIntervalSince1970.truncatingRemainder(dividingBy: 4) / 4
                ZStack(alignment: .leading) { Capsule().fill(.gray.opacity(0.12)); Circle().fill(.mint.gradient).frame(width: 58, height: 58).offset(x: phase * 620) }.frame(height: 58)
            }
            Text("\(items) demo items created").font(.system(size: 38, weight: .medium, design: .rounded))
            Button("Create demo item") { items += 1 }.buttonStyle(.borderedProminent).controlSize(.large).accessibilityLabel("Create demo item")
            Text("Only synthetic content appears in this window.").foregroundStyle(.secondary)
        }.padding(50).frame(width: 720, height: 440).foregroundStyle(Theme.ink).background(Theme.bg)
    }
}
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    let studio = Studio()
    func applicationWillFinishLaunching(_ notification: Notification) {
        // The product identity is pale optical glass; the app keeps the light appearance in every system mode.
        NSApp.appearance = NSAppearance(named: .aqua)
        // Support/diagnostics: `Toru --check-permission` prints the Screen Recording grant as macOS sees this exact app identity.
        if CommandLine.arguments.contains("--list-sources") {
            // Runs under the app's own identity when launched with `open`, so TCC attributes the request to Toru itself.
            Task { @MainActor in
                do {
                    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                    NSLog("Toru list-sources ok: %ld windows, %ld displays", content.windows.count, content.displays.count)
                    try? "ok \(content.windows.count) \(content.displays.count)".write(toFile: "/tmp/toru-list-sources.txt", atomically: true, encoding: .utf8)
                } catch {
                    NSLog("Toru list-sources failed: %@", error.localizedDescription)
                    try? "error \((error as NSError).domain) \((error as NSError).code) \(error.localizedDescription)".write(toFile: "/tmp/toru-list-sources.txt", atomically: true, encoding: .utf8)
                }
                exit(0)
            }
            return
        }
        if let i = CommandLine.arguments.firstIndex(of: "--snapshot"), CommandLine.arguments.count > i + 1 {
            // Design review aid: capture the screen region around the floating bar after launch.
            let path = CommandLine.arguments[i + 1]
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))
                await studio.snapshotBar(to: path)
            }
        }
        if CommandLine.arguments.contains("--check-permission") {
            let granted = CGPreflightScreenCaptureAccess()
            print("screen-recording-granted=\(granted) bundle=\(Bundle.main.bundlePath)")
            exit(granted ? 0 : 2)
        }
    }
    #if canImport(Sparkle)
    private lazy var sparkle = SparkleBridge(studio: studio)
    #endif
    func applicationDidFinishLaunching(_ notification: Notification) {
        #if canImport(Sparkle)
        _ = sparkle
        #endif
        // The bar is the default surface. State restoration may bring the library back; keep it closed unless the bar is off.
        if studio.showHUD {
            DispatchQueue.main.async { for window in NSApp.windows where window.identifier?.rawValue == "main" { window.close() } }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task { await studio.disconnect(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}
#if !TORU_TESTING
@main
#endif
struct ToruApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        Window("Toru", id: "main") { StudioView(studio: delegate.studio).onOpenURL { url in delegate.studio.applySetupLink(url) } }
            .windowStyle(.hiddenTitleBar).windowResizability(.contentMinSize).defaultSize(width: 980, height: 680)
            .defaultLaunchBehavior(.suppressed)
            .commands {
                CommandMenu("Recording") {
                    Button("Stop recording") { Task { await delegate.studio.stop() } }
                        .keyboardShortcut(".", modifiers: [.command, .shift])
                        .disabled(!delegate.studio.connected && !delegate.studio.recording)
                }
            }
        Settings { SettingsView(studio: delegate.studio) }
        MenuBarExtra {
            RecorderMenu(studio: delegate.studio)
        } label: {
            if let icon = Bundle.main.url(forResource: "Toru", withExtension: "icns").flatMap({ NSImage(contentsOf: $0) }) {
                let sized: NSImage = { let i = icon.copy() as! NSImage; i.size = NSSize(width: 18, height: 18); i.isTemplate = false; return i }()
                Image(nsImage: sized)
            } else { Image(systemName: "camera.aperture") }
        }
        Window("Toru Capture Demo", id: "demo") { DemoView() }.windowResizability(.contentSize)
    }
}

struct RecorderMenu: View {
    @ObservedObject var studio: Studio
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Text(studio.status)
        if studio.recording { CaptureIndicator(studio: studio) }
        Button("Show floating bar") { studio.showBar() }
        Button("Open library") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
        Button(studio.manual ? "Stop and upload" : "Stop sharing") { Task { await studio.stop() } }.disabled(!studio.connected && !studio.recording)
        Divider()
        Button("Quit Toru") { NSApp.terminate(nil) }
    }
}

struct UpdateBanner: View {
    @ObservedObject var studio: Studio
    var body: some View {
        switch studio.update {
        case .available(let version):
            HStack(spacing: 10) { Text("Toru \(version) is available.").font(Theme.sans(12)).foregroundStyle(Theme.ink); Button("Download") { studio.openDownloadPage() }.buttonStyle(QuietButtonStyle()) }
        case .required(let version):
            HStack(spacing: 10) { Text("Update to Toru \(version) to start new recordings. Current uploads continue.").font(Theme.sans(12)).foregroundStyle(Theme.danger); Button("Download") { studio.openDownloadPage() }.buttonStyle(QuietButtonStyle()) }
        case .none, .deferred:
            EmptyView()
        }
    }
}
struct CaptureIndicator: View {
    @ObservedObject var studio: Studio
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(0, Int(context.date.timeIntervalSince(studio.capture.started ?? context.date)))
            VStack(spacing: 4) {
                Text("\(seconds / 60):\(String(format: "%02d", seconds % 60))").font(Theme.sans(28, .medium)).monospacedDigit().foregroundStyle(Theme.ink)
                Text(studio.recordingSource).font(Theme.sans(12)).foregroundStyle(Theme.muted).lineLimit(1)
            }
        }
    }
}


#if canImport(Sparkle)
import Sparkle
/// Sparkle drives signed download/verification/install (SUFeedURL + SUPublicEDKey in Info.plist). Recording always wins.
@MainActor final class SparkleBridge: NSObject, SPUUpdaterDelegate {
    private let studio: Studio
    private(set) var controller: SPUStandardUpdaterController?
    init(studio: Studio) {
        self.studio = studio
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }
    nonisolated func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        let busy = MainActor.assumeIsolated { studio.recording || studio.uploading }
        if busy { throw ToruError(message: "Recording or uploading; update check postponed.") }
    }
    nonisolated func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        MainActor.assumeIsolated {
            guard studio.recording || studio.uploading else { return false }
            Task { @MainActor in
                while studio.recording || studio.uploading { try? await Task.sleep(for: .seconds(2)) }
                installHandler()
            }
            return true
        }
    }
    nonisolated func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        UserDefaults.standard.bool(forKey: "betaUpdates") ? ["beta"] : []
    }
}
#endif

