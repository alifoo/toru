import Foundation
import CryptoKit

/// Disk reads and hashing stay off the UI actor; memory is bounded to one chunk.
enum CaptureTransfer {
    static func fingerprint(_ file: URL) async throws -> (bytes: Int, sha256: String) {
        try await Task.detached(priority: .utility) {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var hash = SHA256(), total = 0
            while let data = try handle.read(upToCount: 4 * 1024 * 1024), !data.isEmpty {
                hash.update(data: data); total += data.count
                guard total <= 256 * 1024 * 1024 else { throw ToruError(message: "Capture exceeds upload limit. Local video saved.") }
            }
            guard total > 0 else { throw ToruError(message: "Local video is empty.") }
            return (total, hash.finalize().map { String(format: "%02x", $0) }.joined())
        }.value
    }
    static func chunk(_ file: URL, offset: Int, count: Int) async throws -> Data {
        try await Task.detached(priority: .utility) {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset))
            guard let data = try handle.read(upToCount: count), data.count == count else { throw ToruError(message: "Local video changed while uploading.") }
            return data
        }.value
    }
}
