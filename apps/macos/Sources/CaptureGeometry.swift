import Foundation
import CoreGraphics

/// H.264 needs even dimensions. Scale both axes together; never stretch a small source.
///
/// A source is recorded at its own pixel density (2 on a Retina screen) up to 2560x1440, the size Toru for Chrome
/// records at, so a 1920 or 2560 render and its zooms stay sharp.
struct CaptureGeometry: Equatable {
    let width: Int
    let height: Int
    static let maxWidth: Double = 2560, maxHeight: Double = 1440
    init?(width: Double, height: Double, pixelScale: Double = 1, maxWidth: Double = CaptureGeometry.maxWidth, maxHeight: Double = CaptureGeometry.maxHeight) {
        guard width.isFinite, height.isFinite, pixelScale.isFinite,
              width > 0, height > 0, pixelScale > 0 else { return nil }
        let pixelsWide = width * pixelScale, pixelsHigh = height * pixelScale
        guard pixelsWide.isFinite, pixelsHigh.isFinite else { return nil }
        let factor = min(1, min(maxWidth / pixelsWide, maxHeight / pixelsHigh))
        let targetWidth = Int((pixelsWide * factor).rounded(.down)) / 2 * 2
        let targetHeight = Int((pixelsHigh * factor).rounded(.down)) / 2 * 2
        guard targetWidth >= 2, targetHeight >= 2 else { return nil }
        self.width = targetWidth; self.height = targetHeight
    }
}

/// How a capture is encoded: frame size, target bitrate and whether only a hardware encoder will do.
struct CaptureEncoding: Equatable {
    let size: CaptureGeometry
    let bitrate: Int
    let requiresHardware: Bool

    private static let fullHD = 1920.0 * 1080

    /// Target H.264 bitrate at a size, the same ladder as Toru for Chrome: a screen recording is text on flat colour
    /// that mostly holds still, so the encoder spends far less than this on most seconds. 6 Mbps at 2560x1440 (a
    /// five-minute recording of nonstop scrolling stays near 225 MB, inside the 256 MiB upload limit), 4 Mbps at
    /// 1920x1080, and at 1280x720 or less what mediabunny calls high quality (~2.8 Mbps at 720p).
    static func bitrate(width: Int, height: Int) -> Int {
        let pixels = Double(width * height)
        if pixels > fullHD { return Int((6_000_000 * pixels / (2560 * 1440) / 1000).rounded()) * 1000 }
        if pixels > 1280 * 720 { return Int((4_000_000 * pixels / fullHD / 1000).rounded()) * 1000 }
        return Int((3_000_000 * pow(pixels / fullHD, 0.95) * 2 / 1000).rounded(.up)) * 1000
    }

    /// What to try, best first: the source at up to 2560x1440, then up to 1920x1080 and 1280x720, never larger than
    /// the source itself. Above 1080p only a hardware encoder is accepted: a software one at that size cannot keep up
    /// with 60fps, and 1080p with every frame beats 1440p with dropped ones.
    static func candidates(width: Double, height: Double, pixelScale: Double) -> [CaptureEncoding] {
        var sizes: [CaptureGeometry] = []
        for (maxWidth, maxHeight) in [(2560.0, 1440.0), (1920, 1080), (1280, 720)] {
            if let size = CaptureGeometry(width: width, height: height, pixelScale: pixelScale, maxWidth: maxWidth, maxHeight: maxHeight),
               !sizes.contains(size) { sizes.append(size) }
        }
        return sizes.map { CaptureEncoding(size: $0, bitrate: bitrate(width: $0.width, height: $0.height),
                                           requiresHardware: Double($0.width * $0.height) > fullHD) }
    }

    /// The first candidate this Mac can encode, or nil when none can.
    static func choose(_ candidates: [CaptureEncoding], canEncode: (CaptureEncoding) -> Bool) -> CaptureEncoding? {
        candidates.first(where: canEncode)
    }
}

/// Where the shared window and the app's popups (menus, popovers, sheets) sit inside the recorded region over time,
/// as fractions of it. The recording keeps a margin around the window; the render paints a background there and
/// shows only these rectangles, so a menu that reaches past the window is shown whole instead of cut at its edge.
struct CaptureLayers: Codable, Equatable {
    struct Rect: Codable, Equatable {
        var x: Double, y: Double, width: Double, height: Double
        /// Corner radius as a fraction of the region's width.
        var radius: Double
        var kind: String
    }
    struct Sample: Codable, Equatable {
        var atMs: Int
        var rects: [Rect]
    }
    var samples: [Sample] = []

    /// Keeps a sample only when what is on screen changed; at most 2,000. A rectangle that went away was already
    /// fading out for up to one sampling interval before it was seen gone, so its removal is dated that much earlier.
    @discardableResult
    mutating func note(atMs: Int, rects: [Rect], interval: Int = 33) -> Bool {
        guard samples.count < 2_000, samples.last?.rects != rects else { return false }
        let removed = samples.last.map { last in last.rects.contains { !rects.contains($0) } } ?? false
        let at = removed ? max(samples.last?.atMs ?? 0, atMs - interval) : atMs
        samples.append(Sample(atMs: max(0, at), rects: rects))
        return true
    }

    /// The window with room around it on its display: menus open past the window's edge into this margin.
    static func region(window: CGRect, display: CGRect, margin: CGFloat = 200) -> CGRect {
        let wide = window.insetBy(dx: -margin, dy: -margin).intersection(display)
        return wide.isNull ? window : wide.integral
    }

    /// Screen rectangles (points) as fractions of the region, clipped to it.
    static func rects(_ frames: [(frame: CGRect, radius: CGFloat, kind: String)], in region: CGRect) -> [Rect] {
        guard region.width > 0, region.height > 0 else { return [] }
        return frames.compactMap { item in
            let clipped = item.frame.intersection(region)
            guard !clipped.isNull, clipped.width >= 4, clipped.height >= 4 else { return nil }
            func round4(_ v: Double) -> Double { (v * 10_000).rounded() / 10_000 }
            return Rect(x: round4((clipped.minX - region.minX) / region.width), y: round4((clipped.minY - region.minY) / region.height),
                        width: round4(clipped.width / region.width), height: round4(clipped.height / region.height),
                        radius: round4(item.radius / region.width), kind: item.kind)
        }
    }

    var payload: [String: Any] {
        ["samples": samples.map { sample in
            ["atMs": sample.atMs, "rects": sample.rects.map { ["x": $0.x, "y": $0.y, "width": $0.width, "height": $0.height, "radius": $0.radius, "kind": $0.kind] }]
        }]
    }
}
