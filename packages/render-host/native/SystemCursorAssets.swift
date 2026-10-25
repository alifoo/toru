// Prints this Mac's own cursor pictures as JSON, keyed by the cursor names OpenScreen's renderer uses:
// { "arrow": { "dataUrl", "hotspotX", "hotspotY", "width", "height" }, ... }.
//
// Each picture is trimmed to its visible pixels and scaled to a fixed height, so the renderer can draw it at any
// size without blur, and the hotspot (the tip that clicks) is moved with it. Nothing is bundled: the pictures are
// read from the machine that renders.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

// AppKit hands back empty cursor images until the shared application exists.
_ = NSApplication.shared

/// Every picture comes out this many pixels tall: enough detail for the renderer's largest cursor sizes.
let outputHeight = 1024

struct Asset: Encodable {
    let dataUrl: String
    let hotspotX: Double
    let hotspotY: Double
    let width: Double
    let height: Double
}

/// The cursor's largest bitmap, as a CGImage.
func largestImage(of cursor: NSCursor) -> CGImage? {
    let image = cursor.image
    let reps = image.representations.sorted { $0.pixelsWide * $0.pixelsHigh > $1.pixelsWide * $1.pixelsHigh }
    for rep in reps {
        if let bitmap = rep as? NSBitmapImageRep, let cg = bitmap.cgImage { return cg }
    }
    var rect = CGRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

/// An RGBA context of the given size whose memory starts at the picture's top row.
func rgbaContext(width: Int, height: Int) -> CGContext? {
    CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
}

/// The smallest rectangle (top-left origin, pixels) holding every pixel that is not fully see-through.
func visibleBounds(of image: CGImage) -> CGRect? {
    let width = image.width, height = image.height
    guard let context = rgbaContext(width: width, height: height) else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let pixels = context.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
    var left = width, top = height, right = -1, bottom = -1
    for row in 0..<height {
        for column in 0..<width where pixels[row * width * 4 + column * 4 + 3] > 2 {
            left = min(left, column); right = max(right, column)
            top = min(top, row); bottom = max(bottom, row)
        }
    }
    guard right >= left, bottom >= top else { return nil }
    return CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
}

func png(_ image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
}

func asset(for cursor: NSCursor) -> Asset? {
    guard let source = largestImage(of: cursor), let visible = visibleBounds(of: source),
          let trimmed = source.cropping(to: visible) else { return nil }
    // The hotspot is in points from the top-left; the bitmap may hold 2 or more pixels per point.
    let pixelsPerPoint = CGFloat(source.height) / max(1, cursor.image.size.height)
    let scale = CGFloat(outputHeight) / visible.height
    let width = max(1, Int((visible.width * scale).rounded(.up)))
    guard let context = rgbaContext(width: width, height: outputHeight) else { return nil }
    // Hard pixel edges: the renderer scales the picture down, and smoothing here would soften the outline.
    context.interpolationQuality = .none
    context.draw(trimmed, in: CGRect(x: 0, y: 0, width: width, height: outputHeight))
    guard let scaled = context.makeImage(), let bytes = png(scaled) else { return nil }
    return Asset(
        dataUrl: "data:image/png;base64," + bytes.base64EncodedString(),
        hotspotX: Double((cursor.hotSpot.x * pixelsPerPoint - visible.minX) * scale),
        hotspotY: Double((cursor.hotSpot.y * pixelsPerPoint - visible.minY) * scale),
        width: Double(width),
        height: Double(outputHeight)
    )
}

let cursors: [(String, NSCursor)] = [
    ("arrow", .arrow), ("text", .iBeam), ("pointer", .pointingHand), ("crosshair", .crosshair),
    ("open-hand", .openHand), ("closed-hand", .closedHand), ("resize-ew", .resizeLeftRight),
    ("resize-ns", .resizeUpDown), ("not-allowed", .operationNotAllowed),
]
var assets: [String: Asset] = [:]
for (name, cursor) in cursors {
    if let made = asset(for: cursor) { assets[name] = made }
}
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try encoder.encode(assets))
