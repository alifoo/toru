import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision

/// What Toru reads from a window when Accessibility shows nothing useful (canvas apps such as Figma, Electron
/// apps that keep their tree to themselves): a screenshot of the window, read on this Mac with Vision's text
/// recognition. Each line of text becomes a control in the same outline Jev reads, marked `visual`; acting on
/// it clicks its position instead of pressing an Accessibility element. No image leaves the Mac for this.
enum VisualOutline {
    /// Apps whose content Accessibility does not describe, read visually even when a few controls are exposed.
    static let canvasApps: Set<String> = ["com.figma.Desktop", "com.bohemiancoding.sketch3", "com.adobe.illustrator", "com.adobe.Photoshop", "com.miro.desktop"]

    /// A window's pixels, synchronously, for callers already off the main thread.
    static func capture(windowID: CGWindowID) throws -> CGImage {
        let done = DispatchSemaphore(value: 0)
        var result: Result<CGImage, Error> = .failure(InputError.notFound("screenshot"))
        Task.detached {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                guard let window = content.windows.first(where: { $0.windowID == windowID }) else { throw InputError.notFound("window") }
                // The screen rectangle of the window maps one to one to its points. A window capture also draws the
                // window's shadow and shrinks the window to fit, which shifts every position by a few percent.
                if #available(macOS 15.2, *), window.isOnScreen {
                    result = .success(try await SCScreenshotManager.captureImage(in: window.frame))
                    done.signal(); return
                }
                let config = SCStreamConfiguration()
                // The window's own display scale: a 2x capture of a window on a 1x display leaves the content in a corner.
                var display = CGDirectDisplayID(0), count: UInt32 = 0
                CGGetDisplaysWithPoint(CGPoint(x: window.frame.midX, y: window.frame.midY), 1, &display, &count)
                let mode = count > 0 ? CGDisplayCopyDisplayMode(display) : nil
                let scale = mode.map { Double($0.pixelWidth) / Double(max(1, $0.width)) } ?? 2
                config.width = Int(window.frame.width * scale); config.height = Int(window.frame.height * scale); config.showsCursor = false
                // Without this the shadow is captured too and the window shrinks inside the image, shifting every position.
                config.ignoreShadowsSingleWindow = true
                result = .success(try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config))
            } catch { result = .failure(error) }
            done.signal()
        }
        guard done.wait(timeout: .now() + 5) == .success else { throw InputError.notFound("screenshot in time") }
        return try result.get()
    }

    /// Lines of text with their frames in global screen points.
    static func recognize(_ image: CGImage, window: CGRect) throws -> [(text: String, frame: CGRect)] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.automaticallyDetectsLanguage = true
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.4 else { return nil }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            // Vision's boxes are normalized with the origin at the bottom left.
            let box = observation.boundingBox
            let frame = CGRect(x: window.minX + box.minX * window.width, y: window.minY + (1 - box.maxY) * window.height,
                               width: box.width * window.width, height: box.height * window.height)
            return (text, frame)
        }
    }

    /// Adds the window's visible text to an Accessibility snapshot: as targets when the tree has few controls
    /// (or the app is a canvas app), and always to the page text so Jev can read what the window shows.
    static func augment(_ snapshot: OutlineSnapshot, windowID: CGWindowID, pid: pid_t, force: Bool) -> OutlineSnapshot {
        let content = snapshot.targets.values.filter { $0.role != "menubaritem" }
        // Native apps draw some controls with no Accessibility element at all (Books' "Seções" menu): their windows
        // are read from pixels too, adding only text no listed control covers. Web content names what it shows.
        guard force || content.count < 3 || !snapshot.web else { return snapshot }
        guard let image = try? capture(windowID: windowID), let lines = try? recognize(image, window: snapshot.window), !lines.isEmpty else { return snapshot }
        var outline = snapshot.outline, targets = snapshot.targets, index = snapshot.elements
        let app = AXUIElementCreateApplication(pid)
        var added = 0
        for line in lines where added < 150 {
            // Text already covered by an Accessibility control is not listed twice.
            if content.contains(where: { $0.frame.insetBy(dx: -4, dy: -4).contains(CGPoint(x: line.frame.midX, y: line.frame.midY)) }) { continue }
            index += 1; added += 1
            let ref = "ref_\(index)"
            let name = String(line.text.prefix(120))
            // Short text is usually something to click (a tab, a button, a file name); longer text is content.
            let role = name.split(separator: " ").count <= 5 ? "button" : "text"
            let x = Int((line.frame.midX - snapshot.window.minX).rounded()), y = Int((line.frame.midY - snapshot.window.minY).rounded())
            outline += "\n  [\(ref)] \(role) \(AccessibilityOutline.json(name)) visual — visible at (\(x),\(y)) window points"
            targets[ref] = OutlineTarget(element: app, frame: line.frame, role: role, secure: false, label: "\(role) \(AccessibilityOutline.json(String(name.prefix(80))))", visual: true)
        }
        let text = (snapshot.text.isEmpty ? "" : snapshot.text + "\n") + lines.map(\.text).joined(separator: "\n")
        // A canvas app paints the user's name instead of describing it: found by its pixels, blurred the same way.
        let painted = lines.filter { AccessibilityOutline.showsIdentity([kAXValueAttribute as String: $0.text]) }.map { line in
            line.frame.insetBy(dx: -3, dy: -2)
                .intersection(snapshot.window).offsetBy(dx: -snapshot.window.minX, dy: -snapshot.window.minY)
        }.filter { !$0.isNull && $0.width >= 2 && $0.height >= 2 }
        return OutlineSnapshot(outline: outline, text: String(text.prefix(6_000)), window: snapshot.window, targets: targets,
                               elements: index, milliseconds: snapshot.milliseconds, identity: snapshot.identity + painted, web: snapshot.web)
    }
}
