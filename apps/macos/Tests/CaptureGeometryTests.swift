import Foundation

@main struct CaptureGeometryTests {
    static func main() {
        for scale in [1.0, 2.0] {
            for (width, height) in [(320.0, 200.0), (200, 1200), (2400, 300), (1920, 1080), (3840, 2160)] {
                let size = CaptureGeometry(width: width, height: height, pixelScale: scale)!
                precondition(size.width <= 2560 && size.height <= 1440)
                precondition(size.width % 2 == 0 && size.height % 2 == 0)
                let factor = min(1, min(2560 / (width * scale), 1440 / (height * scale)))
                // At most one even-pixel rounding step on each axis; no independent upscaling.
                precondition(abs(Double(size.width) - width * scale * factor) < 2)
                precondition(abs(Double(size.height) - height * scale * factor) < 2)
            }
        }
        precondition(CaptureGeometry(width: 200, height: 1200)?.width == 200)
        precondition(CaptureGeometry(width: 300, height: 1800)?.width == 240)
        // A Retina window is recorded at its own density up to 2560x1440, as Toru for Chrome records.
        precondition(CaptureGeometry(width: 1280, height: 720, pixelScale: 2) == CaptureGeometry(width: 2560, height: 1440, pixelScale: 1))
        precondition(CaptureGeometry(width: 1440, height: 900, pixelScale: 2).map { [$0.width, $0.height] } == [2304, 1440])
        precondition(CaptureGeometry(width: 1920, height: 1080, pixelScale: 2).map { [$0.width, $0.height] } == [2560, 1440])
        // An odd point size still records even pixels.
        precondition(CaptureGeometry(width: 1471, height: 827, pixelScale: 2).map { $0.width % 2 == 0 && $0.height % 2 == 0 } == true)
        // Bitrates follow Toru for Chrome's ladder: 6 Mbps at 1440p, 4 Mbps at 1080p, ~2.8 Mbps at 720p.
        precondition(CaptureEncoding.bitrate(width: 2560, height: 1440) == 6_000_000)
        precondition(CaptureEncoding.bitrate(width: 1920, height: 1080) == 4_000_000)
        precondition(CaptureEncoding.bitrate(width: 1280, height: 720) == 2_778_000)
        // Five minutes at the largest bitrate stay inside the 256 MiB upload limit, with room for bursts.
        precondition(Double(CaptureEncoding.bitrate(width: 2560, height: 1440)) * 300 / 8 < 256 * 1024 * 1024 * 0.9)
        // The encoder ladder: 2560 wide on a hardware encoder, then 1920 and 1280 on any.
        let ladder = CaptureEncoding.candidates(width: 1920, height: 1080, pixelScale: 2)
        precondition(ladder.map { [$0.size.width, $0.size.height] } == [[2560, 1440], [1920, 1080], [1280, 720]])
        precondition(ladder.map(\.requiresHardware) == [true, false, false])
        precondition(CaptureEncoding.choose(ladder) { $0.size.width <= 1920 }?.size.width == 1920)
        precondition(CaptureEncoding.choose(ladder) { $0.size.width <= 1280 }?.bitrate == 2_778_000)
        precondition(CaptureEncoding.choose(ladder) { _ in false } == nil)
        // Never larger than the source: a 1x window of 1280x800 records 1280x800 first.
        precondition(CaptureEncoding.candidates(width: 1280, height: 800, pixelScale: 1).map { $0.size.width } == [1280, 1152])
        precondition(CaptureGeometry(width: 320, height: 200)?.height == 200)
        precondition(CaptureGeometry(width: 0, height: 100) == nil)
        precondition(CaptureGeometry(width: .infinity, height: 100) == nil)
        precondition(CaptureGeometry(width: 100, height: 100, pixelScale: .nan) == nil)
        precondition(CaptureGeometry(width: 1, height: 10000) == nil)
        // The recorded region keeps a margin around the window, inside its display.
        let display = CGRect(x: 1710, y: 32, width: 1920, height: 1080)
        let region = CaptureLayers.region(window: CGRect(x: 1950, y: 110, width: 1440, height: 880), display: display)
        precondition(region == CGRect(x: 1750, y: 32, width: 1840, height: 1080))
        // A menu past the window's edge is a rectangle of its own, in fractions of the region, clipped to it.
        let rects = CaptureLayers.rects([(CGRect(x: 1950, y: 110, width: 1440, height: 880), 26, "window"),
                                         (CGRect(x: 3300, y: 150, width: 400, height: 300), 12, "popup")], in: region)
        precondition(rects.count == 2 && rects[0].x == 0.1087 && rects[1].x + rects[1].width <= 1.0001 && rects[1].kind == "popup")
        var layers = CaptureLayers()
        precondition(layers.note(atMs: 0, rects: rects) && !layers.note(atMs: 100, rects: rects) && layers.note(atMs: 200, rects: [rects[0]]))
        precondition(layers.samples.count == 2)
        // A menu that went away is dated one interval earlier: it was already fading.
        precondition(layers.samples[1].atMs == 167)
        print("PASS: small/tall/wide, Retina/non-Retina, bounded even dimensions, invalid source rejection, encoder ladder and bitrates")
    }
}
