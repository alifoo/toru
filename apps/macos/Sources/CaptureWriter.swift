import AVFoundation
import ScreenCaptureKit
import VideoToolbox

/// Writes ScreenCaptureKit frames to an H.264 MP4 at a chosen size and bitrate.
///
/// ScreenCaptureKit's own recording output picks its bitrate itself; a 2560x1440 capture needs the same ladder Toru
/// for Chrome uses (CaptureEncoding) to stay inside the upload limit, so frames go through AVAssetWriter instead.
/// Frames arrive only when the picture changes; a still screen is one long frame, and the file ends at the time Stop
/// was pressed, so pauses stay pauses.
final class CaptureWriter: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "tools.toru.mac.capture-writer")
    let encoding: CaptureEncoding
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    // Touched only on `queue`.
    private var sessionStarted = false
    private var lastTime = CMTime.invalid
    private var finishing = false
    private var failed: Error?
    /// The first frame was written: the recording has started.
    var onFirstFrame: (@Sendable () -> Void)?
    var onFailure: (@Sendable (Error) -> Void)?

    static let frameRate = 60

    /// Whether this Mac can encode H.264 at a size (only in hardware when `hardware`), asked of VideoToolbox without
    /// encoding anything.
    static func canEncode(_ encoding: CaptureEncoding) -> Bool {
        if let forced = UserDefaults.standard.object(forKey: "captureMaxWidth") as? Int, encoding.size.width > forced { return false }
        var session: VTCompressionSession?
        let specification: CFDictionary? = encoding.requiresHardware
            ? [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true] as CFDictionary : nil
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(encoding.size.width), height: Int32(encoding.size.height),
                                                codecType: kCMVideoCodecType_H264, encoderSpecification: specification,
                                                imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil,
                                                refcon: nil, compressionSessionOut: &session)
        guard status == noErr, let session else { return false }
        defer { VTCompressionSessionInvalidate(session) }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: frameRate))
        return VTCompressionSessionPrepareToEncodeFrames(session) == noErr
    }

    init(url: URL, encoding: CaptureEncoding) throws {
        self.encoding = encoding
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        var settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: encoding.size.width, AVVideoHeightKey: encoding.size.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: encoding.bitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: Self.frameRate,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        if encoding.requiresHardware {
            settings[AVVideoEncoderSpecificationKey] = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true]
        }
        input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw ToruError(message: "This Mac cannot encode the recording.") }
        writer.add(input)
        super.init()
        guard writer.startWriting() else { throw writer.error ?? ToruError(message: "This Mac cannot encode the recording.") }
    }

    /// Stream configuration matching the encoder: its frame size, 4:2:0 frames in BT.709, up to 60 a second.
    func configure(_ config: SCStreamConfiguration) {
        config.width = encoding.size.width; config.height = encoding.size.height
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        config.colorSpaceName = CGColorSpace.sRGB
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(Self.frameRate))
    }

    /// Now, on the clock ScreenCaptureKit stamps frames with.
    static func now() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        append(sampleBuffer)
    }

    /// One frame from the stream, on `queue`.
    func append(_ sampleBuffer: CMSampleBuffer) {
        guard !finishing, failed == nil, sampleBuffer.isValid else { return }
        // Only complete frames carry a new picture; idle frames repeat the last one and are left out.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        let time = sampleBuffer.presentationTimeStamp
        guard time.isValid, !lastTime.isValid || time > lastTime else { return }
        if !sessionStarted {
            writer.startSession(atSourceTime: time)
            sessionStarted = true
        }
        // Under pressure, drop a frame rather than queue frames without bound.
        guard input.isReadyForMoreMediaData else { return }
        if input.append(sampleBuffer) {
            let first = !lastTime.isValid
            lastTime = time
            if first { onFirstFrame?() }
        } else {
            fail(writer.error ?? ToruError(message: "The recording could not be encoded."))
        }
    }

    private func fail(_ error: Error) {
        guard failed == nil else { return }
        failed = error
        onFailure?(error)
    }

    /// Closes the file, ending it at `end` (when Stop was pressed) so a still last frame keeps its length. Throws when
    /// nothing was written or the encoder failed.
    func finish(at end: CMTime) async throws {
        let state: (started: Bool, last: CMTime, failure: Error?) = queue.sync {
            finishing = true
            return (sessionStarted && lastTime.isValid, lastTime, failed)
        }
        guard state.started, state.failure == nil, writer.status == .writing else {
            if writer.status == .writing { writer.cancelWriting() }
            throw state.failure ?? writer.error ?? ToruError(message: "The recording has no frames.")
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: max(end, state.last))
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? ToruError(message: "The recording could not be saved.") }
    }

    /// Gives up before any frame was written (a failed start): no file is left behind.
    func cancel() {
        queue.sync { finishing = true }
        if writer.status == .writing { writer.cancelWriting() }
    }
}
