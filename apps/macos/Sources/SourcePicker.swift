import AppKit
import ScreenCaptureKit

/// Selection never authorizes capture; Studio still requires explicit per-recording approval.
@MainActor final class SourcePicker: NSObject, SCContentSharingPickerObserver {
    var selected: ((CaptureSource) -> Void)?
    var canceled: (() -> Void)?
    var failed: (() -> Void)?
    private var accepting = false
    override init() {
        super.init()
        SCContentSharingPicker.shared.add(self)
    }
    func present() {
        var config = SCContentSharingPickerConfiguration()
        config.allowedPickerModes = [.singleWindow, .singleDisplay]
        config.allowsChangingSelectedContent = false
        config.excludedWindowIDs = NSApp.windows.filter { $0.identifier?.rawValue != "demo" }.map { $0.windowNumber }
        let picker = SCContentSharingPicker.shared
        picker.defaultConfiguration = config
        picker.maximumStreamCount = 1
        accepting = true; picker.isActive = true; picker.present()
    }
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        Task { @MainActor in
            guard self.accepting, stream == nil else { return }
            self.accepting = false
            guard let size = CaptureGeometry(width: filter.contentRect.width, height: filter.contentRect.height, pixelScale: Double(filter.pointPixelScale)) else {
                self.failed?(); return
            }
            let title = filter.style == .display ? "Selected display (includes other visible apps)" : "Selected window"
            var source = CaptureSource(id: UUID().uuidString, title: title, filter: filter, width: size.width, height: size.height)
            if #available(macOS 15.2, *) {
                source.windowIDs = filter.includedWindows.map(\.windowID)
                source.displayIDs = filter.includedDisplays.map(\.displayID)
            }
            self.selected?(source)
        }
    }
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        Task { @MainActor in
            guard self.accepting, stream == nil else { return }
            self.accepting = false; self.canceled?()
        }
    }
    nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) {
        Task { @MainActor in
            guard self.accepting else { return }
            self.accepting = false; self.failed?()
        }
    }
}
