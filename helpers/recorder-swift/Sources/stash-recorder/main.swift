import Foundation
import AVFoundation
import CoreMedia
#if os(macOS)
import AppKit
import ScreenCaptureKit
#endif

// MARK: - Protocol
//
// Stash talks to this helper over stdin/stdout. Each side sends line-delimited
// JSON. This is intentionally transport-minimal so the Rust side can wire it
// up with a BufReader.
//
// Incoming commands (one per line):
//   { "cmd": "start", "mode": "screen", "mic": false,
//     "display_id": null, "fps": 60, "output": "/path/to/out.mov" }
//   { "cmd": "stop" }
//   { "cmd": "status" }
//   { "cmd": "probe_permissions" }
//   { "cmd": "list_devices" }
//
// Outgoing events:
//   { "event": "ready", "pid": 1234 }
//   { "event": "recording_started", "path": "/path/to/out.mov" }
//   { "event": "stopped", "path": "/path/to/out.mov" }
//   { "event": "error", "message": "..." }
//   { "event": "status", "recording": true, "path": "..." }
//   { "event": "permissions",
//     "screen": true, "microphone": false, "camera": false }
//   { "event": "devices",
//     "displays": [{ "id": "69733378", "name": "Studio Display",
//                    "width": 5120, "height": 2880, "primary": true }],
//     "cameras":  [{ "id": "0x1420000005ac8600", "name": "FaceTime HD" }],
//     "microphones": [{ "id": "BuiltInMicrophoneDevice", "name": "MacBook Pro Microphone" }] }

struct StartArgs: Decodable {
    let mode: String?
    let mic: Bool?
    let display_id: String?
    let fps: Int?
    let output: String
}

struct CamOverlay: Decodable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let shape: String?  // "rect" | "circle"
}

struct Command: Decodable {
    let cmd: String
    let mode: String?
    let mic: Bool?
    let display_id: String?
    let fps: Int?
    let output: String?
    let mic_ids: [String]?
    let system_audio: Bool?
    let camera_id: String?
    let cam_overlay: CamOverlay?
    let excluded_window_titles: [String]?
    /// Optional per-source gain multiplier keyed by source id
    /// ("mic:<uniqueID>" or "system"). 1.0 is unity; absent = unity.
    let source_gains: [String: Double]?
    /// Source ids to skip entirely. Silence without dropping the track so
    /// timeline alignment with the screen video is preserved.
    let muted_sources: [String]?
}

// MARK: - Event encoding

let stdout = FileHandle.standardOutput
let stderr = FileHandle.standardError

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
        return
    }
    stdout.write(data)
    stdout.write(Data([0x0A])) // \n
}

func emitError(_ msg: String) {
    emit(["event": "error", "message": msg])
}

// MARK: - Screen recorder (ScreenCaptureKit + AVAssetWriter)
//
// SCStream delivers BGRA video samples which we feed directly into an
// AVAssetWriter .mov container. Audio sources (multiple microphones and
// optionally system audio) are recorded as parallel AAC tracks — one track
// per source. This is the "multi-track" flavour of OBS mixing and lets users
// remix in post. RMS levels are emitted at ~20Hz per source so the UI can
// render live meters.

#if os(macOS)

/// Per-mic delegate — keeps `sourceId` in scope so ScreenRecorder knows which
/// track the buffer belongs to.
final class MicCaptureDelegate: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let sourceId: String
    weak var recorder: ScreenRecorder?
    init(sourceId: String, recorder: ScreenRecorder) {
        self.sourceId = sourceId
        self.recorder = recorder
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        recorder?.handleAudioBuffer(sourceId: sourceId, sampleBuffer: sampleBuffer)
    }
}

/// Captures a single camera as a stream of CVPixelBuffers. In `cam` mode the
/// sample buffers flow straight into the writer; in `screen+cam` the buffers
/// are cached so the screen compositor can overlay the most recent frame.
final class CameraCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    private(set) var latestPixelBuffer: CVPixelBuffer?
    private(set) var width: Int = 0
    private(set) var height: Int = 0
    /// When non-nil, each camera frame is appended directly to this input
    /// (used in cam-only mode).
    var directWriterInput: AVAssetWriterInput?
    /// Set to the first CMSampleBuffer's PTS so the writer session can begin
    /// on a camera sample in cam-only mode.
    var onFirstSample: ((CMSampleBuffer) -> Void)?

    func start(cameraId: String, queue: DispatchQueue) throws {
        guard let device = AVCaptureDevice(uniqueID: cameraId) else {
            throw NSError(domain: "stash-recorder", code: 10,
                userInfo: [NSLocalizedDescriptionKey: "camera not found: \(cameraId)"])
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw NSError(domain: "stash-recorder", code: 11,
                userInfo: [NSLocalizedDescriptionKey: "cannot add camera input"])
        }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String:
                kCVPixelFormatType_32BGRA,
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else {
            throw NSError(domain: "stash-recorder", code: 12,
                userInfo: [NSLocalizedDescriptionKey: "cannot add camera output"])
        }
        session.addOutput(output)
        // Report native dimensions from the active format.
        let desc = device.activeFormat.formatDescription
        let dims = CMVideoFormatDescriptionGetDimensions(desc)
        width = Int(dims.width)
        height = Int(dims.height)
        session.startRunning()
    }

    func stop() {
        session.stopRunning()
        latestPixelBuffer = nil
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        latestPixelBuffer = pb
        if let callback = onFirstSample {
            onFirstSample = nil
            callback(sampleBuffer)
        }
        if let writer = directWriterInput, writer.isReadyForMoreMediaData {
            writer.append(sampleBuffer)
        }
    }
}

/// Overlays a camera frame on top of a screen frame using CoreImage. The
/// overlay rect uses top-left origin in screen pixels; CoreImage's bottom-left
/// origin is handled internally.
final class Compositor {
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private var pool: CVPixelBufferPool?
    private let canvasWidth: Int
    private let canvasHeight: Int
    var overlay: CamOverlay
    private let flippedOverlayY: CGFloat

    init(canvasWidth: Int, canvasHeight: Int, overlay: CamOverlay) {
        self.canvasWidth = canvasWidth
        self.canvasHeight = canvasHeight
        self.overlay = overlay
        // CoreImage origin is bottom-left; flip the overlay Y.
        self.flippedOverlayY = CGFloat(canvasHeight) - CGFloat(overlay.y) - CGFloat(overlay.h)
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: canvasWidth,
            kCVPixelBufferHeightKey as String: canvasHeight,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as CFDictionary,
        ]
        var outPool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &outPool)
        self.pool = outPool
    }

    func compose(screen: CVPixelBuffer, camera: CVPixelBuffer?) -> CVPixelBuffer? {
        let base = CIImage(cvPixelBuffer: screen)
        var result = base
        if let cam = camera {
            let camImage = CIImage(cvPixelBuffer: cam)
            let camW = CGFloat(CVPixelBufferGetWidth(cam))
            let camH = CGFloat(CVPixelBufferGetHeight(cam))
            let sx = CGFloat(overlay.w) / max(camW, 1)
            let sy = CGFloat(overlay.h) / max(camH, 1)
            let scaled = camImage.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
            let positioned = scaled.transformed(
                by: CGAffineTransform(translationX: CGFloat(overlay.x),
                                      y: flippedOverlayY))
            if overlay.shape == "circle" {
                let cx = CGFloat(overlay.x) + CGFloat(overlay.w) / 2
                let cy = flippedOverlayY + CGFloat(overlay.h) / 2
                let r = min(CGFloat(overlay.w), CGFloat(overlay.h)) / 2
                let gradient = CIFilter(name: "CIRadialGradient")!
                gradient.setValue(CIVector(x: cx, y: cy), forKey: "inputCenter")
                gradient.setValue(r * 0.98, forKey: "inputRadius0")
                gradient.setValue(r, forKey: "inputRadius1")
                gradient.setValue(CIColor.white, forKey: "inputColor0")
                gradient.setValue(CIColor(red: 0, green: 0, blue: 0, alpha: 0),
                                  forKey: "inputColor1")
                if let mask = gradient.outputImage {
                    let blend = CIFilter(name: "CIBlendWithAlphaMask")!
                    blend.setValue(positioned, forKey: kCIInputImageKey)
                    blend.setValue(base, forKey: kCIInputBackgroundImageKey)
                    blend.setValue(mask, forKey: kCIInputMaskImageKey)
                    if let out = blend.outputImage { result = out }
                }
            } else {
                result = positioned.composited(over: base)
            }
        }
        guard let pool = pool else { return nil }
        var outBuffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &outBuffer)
        guard let out = outBuffer else { return nil }
        ciContext.render(result, to: out)
        return out
    }
}

final class ScreenRecorder: NSObject, SCStreamDelegate, SCStreamOutput {
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    /// Pixel buffer adaptor for composited frames (screen+cam mode).
    private var pixelAdaptor: AVAssetWriterInputPixelBufferAdaptor?
    /// Writer inputs keyed by source id: "mic:<uniqueID>" or "system".
    private var audioInputs: [String: AVAssetWriterInput] = [:]
    private var audioSession: AVCaptureSession?
    private var micDelegates: [MicCaptureDelegate] = []
    private var camera: CameraCapture?
    private var compositor: Compositor?
    private var mode: String = "screen"
    private var excludedWindowTitles: [String] = []
    private var sourceGains: [String: Double] = [:]
    private var mutedSources: Set<String> = []
    private var sessionStarted = false
    private(set) var outputPath: String?
    private let writerQueue = DispatchQueue(label: "stash.recorder.writer")
    /// Last emission timestamp per source so we can throttle levels to 20Hz.
    private var lastLevelAt: [String: TimeInterval] = [:]

    var isRecording: Bool { stream != nil }

    func start(output: String,
               mode: String,
               displayId: CGDirectDisplayID?,
               fps: Int,
               micIds: [String],
               systemAudio: Bool,
               cameraId: String?,
               camOverlay: CamOverlay?,
               excludedWindowTitles: [String],
               sourceGains: [String: Double],
               mutedSources: [String]) async throws {
        self.mode = mode
        self.excludedWindowTitles = excludedWindowTitles
        self.sourceGains = sourceGains
        self.mutedSources = Set(mutedSources)
        guard stream == nil else {
            throw NSError(domain: "stash-recorder", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "already recording"])
        }
        let fm = FileManager.default
        let dir = (output as NSString).deletingLastPathComponent
        if !fm.fileExists(atPath: dir) {
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
        let outURL = URL(fileURLWithPath: output)
        try? fm.removeItem(at: outURL)

        // Decide canvas dimensions up-front. For cam-only the canvas follows
        // the camera's native resolution; for screen/screen+cam it matches the
        // selected display.
        var canvasW = 0
        var canvasH = 0
        var display: SCDisplay? = nil

        if mode == "cam" {
            guard let id = cameraId, let device = AVCaptureDevice(uniqueID: id) else {
                throw NSError(domain: "stash-recorder", code: 10,
                    userInfo: [NSLocalizedDescriptionKey: "cam mode requires camera_id"])
            }
            let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
            canvasW = Int(dims.width)
            canvasH = Int(dims.height)
        } else {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            if let id = displayId,
               let d = content.displays.first(where: { $0.displayID == id }) {
                display = d
            } else if let d = content.displays.first {
                display = d
            } else {
                throw NSError(domain: "stash-recorder", code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "no displays available"])
            }
            canvasW = display!.width
            canvasH = display!.height
        }

        // AVAssetWriter + video input.
        let writer = try AVAssetWriter(outputURL: outURL, fileType: .mov)
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: canvasW,
            AVVideoHeightKey: canvasH,
        ]
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(videoInput) else {
            throw NSError(domain: "stash-recorder", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "cannot add video input"])
        }
        writer.add(videoInput)

        // Pixel buffer adaptor is required for screen+cam because we hand the
        // writer composited CVPixelBuffers instead of raw CMSampleBuffers.
        var adaptor: AVAssetWriterInputPixelBufferAdaptor? = nil
        if mode == "screen+cam" {
            let sourceAttrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: canvasW,
                kCVPixelBufferHeightKey as String: canvasH,
            ]
            adaptor = AVAssetWriterInputPixelBufferAdaptor(
                assetWriterInput: videoInput,
                sourcePixelBufferAttributes: sourceAttrs)
        }

        // One AAC writer input per audio source (mic | system).
        func addAudioInput(id: String) {
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128_000,
            ]
            let ai = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
            ai.expectsMediaDataInRealTime = true
            if writer.canAdd(ai) {
                writer.add(ai)
                audioInputs[id] = ai
            }
        }
        for id in micIds { addAudioInput(id: "mic:\(id)") }
        if systemAudio { addAudioInput(id: "system") }

        guard writer.startWriting() else {
            throw writer.error ?? NSError(domain: "stash-recorder", code: 4,
                userInfo: [NSLocalizedDescriptionKey: "startWriting failed"])
        }

        self.writer = writer
        self.videoInput = videoInput
        self.pixelAdaptor = adaptor
        self.outputPath = output
        self.sessionStarted = false

        // Default overlay when caller didn't supply one: 320x240 bottom-right,
        // 24px margin. Circle shape.
        let overlay = camOverlay ?? CamOverlay(
            x: Double(canvasW - 320 - 24),
            y: Double(canvasH - 240 - 24),
            w: 320, h: 240, shape: "circle")

        switch mode {
        case "cam":
            // Camera only: AVCaptureSession drives both the writer session
            // (via onFirstSample) and the video track directly.
            guard let id = cameraId else {
                throw NSError(domain: "stash-recorder", code: 10,
                    userInfo: [NSLocalizedDescriptionKey: "cam mode requires camera_id"])
            }
            let cam = CameraCapture()
            cam.directWriterInput = videoInput
            // captureOutput already runs on writerQueue, so `.async` here
            // would reorder startSession *after* the immediately-following
            // append() of the same buffer. Run it synchronously instead.
            cam.onFirstSample = { [weak self] sb in
                guard let self = self else { return }
                if !self.sessionStarted {
                    let ts = CMSampleBufferGetPresentationTimeStamp(sb)
                    self.writer?.startSession(atSourceTime: ts)
                    self.sessionStarted = true
                }
            }
            try cam.start(cameraId: id, queue: writerQueue)
            self.camera = cam

        case "screen+cam":
            guard let scDisplay = display else {
                throw NSError(domain: "stash-recorder", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "no display"])
            }
            self.compositor = Compositor(canvasWidth: canvasW,
                                         canvasHeight: canvasH,
                                         overlay: overlay)
            if let id = cameraId {
                let cam = CameraCapture()
                try cam.start(cameraId: id, queue: writerQueue)
                self.camera = cam
            }
            try await startScreenCapture(display: scDisplay, width: canvasW, height: canvasH,
                                         fps: fps, systemAudio: systemAudio)

        default: // "screen"
            guard let scDisplay = display else {
                throw NSError(domain: "stash-recorder", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "no display"])
            }
            try await startScreenCapture(display: scDisplay, width: canvasW, height: canvasH,
                                         fps: fps, systemAudio: systemAudio)
        }

        if !micIds.isEmpty {
            try startMicCapture(micIds: micIds)
        }
    }

    private func startScreenCapture(display: SCDisplay, width: Int, height: Int,
                                    fps: Int, systemAudio: Bool) async throws {
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(fps, 1)))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.queueDepth = 6
        if systemAudio {
            config.capturesAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
        }
        // Resolve on-screen windows whose titles the caller asked to exclude
        // (the camera PIP preview in particular) so they don't appear inside
        // the recording even though they sit on top of the captured display.
        var excluded: [SCWindow] = []
        if !excludedWindowTitles.isEmpty {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            let titles = Set(excludedWindowTitles)
            excluded = content.windows.filter { w in
                guard let title = w.title else { return false }
                return titles.contains(title)
            }
        }
        // The macOS 14+ replacement (`excludingApplications:exceptingWindows:`)
        // has inverted semantics — `exceptingWindows` means "keep these even
        // though their app is excluded". The deprecated `excludingWindows:`
        // initialiser is the only API that drops specific windows regardless
        // of owning app, so we keep using it.
        let filter = SCContentFilter(display: display, excludingWindows: excluded)
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: writerQueue)
        if systemAudio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: writerQueue)
        }
        self.stream = stream
        try await stream.startCapture()
    }

    private func startMicCapture(micIds: [String]) throws {
        let session = AVCaptureSession()
        for id in micIds {
            guard let device = AVCaptureDevice(uniqueID: id) else {
                continue
            }
            let deviceInput: AVCaptureDeviceInput
            do {
                deviceInput = try AVCaptureDeviceInput(device: device)
            } catch {
                continue
            }
            guard session.canAddInput(deviceInput) else { continue }
            session.addInput(deviceInput)
            let output = AVCaptureAudioDataOutput()
            let delegate = MicCaptureDelegate(sourceId: "mic:\(id)", recorder: self)
            output.setSampleBufferDelegate(delegate, queue: writerQueue)
            guard session.canAddOutput(output) else { continue }
            session.addOutput(output)
            micDelegates.append(delegate)
        }
        if session.inputs.isEmpty {
            throw NSError(domain: "stash-recorder", code: 6,
                userInfo: [NSLocalizedDescriptionKey: "no microphones could be opened"])
        }
        session.startRunning()
        self.audioSession = session
    }

    /// Route an audio sample buffer (from any source) onto its track and emit
    /// an RMS level tick (throttled to 20Hz per source). Applies the mixer's
    /// per-source gain + mute in-place on the backing PCM memory before the
    /// buffer reaches the writer.
    func handleAudioBuffer(sourceId: String, sampleBuffer: CMSampleBuffer) {
        guard let writer = writer, writer.status == .writing,
              sessionStarted,
              let input = audioInputs[sourceId],
              input.isReadyForMoreMediaData else { return }
        if mutedSources.contains(sourceId) {
            // Still emit level so the UI reflects the mute (level forced to 0).
            emit(["event": "audio_level", "source_id": sourceId, "rms": 0])
            return
        }
        let gain = Float(sourceGains[sourceId] ?? 1.0)
        if abs(gain - 1.0) > 0.001 {
            applyGainInPlace(to: sampleBuffer, gain: gain)
        }
        input.append(sampleBuffer)
        maybeEmitLevel(sourceId: sourceId, sampleBuffer: sampleBuffer)
    }

    /// Scale PCM samples in-place with clipping. Works on both 16-bit integer
    /// (AVCaptureAudioDataOutput default) and 32-bit float (SCStream system
    /// audio) buffers — the two formats we actually ship. Other formats fall
    /// through untouched rather than corrupting the track.
    private func applyGainInPlace(to sampleBuffer: CMSampleBuffer, gain: Float) {
        guard let fd = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee,
              let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var lengthOut = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &lengthOut,
            dataPointerOut: &dataPointer)
        guard status == kCMBlockBufferNoErr, let base = dataPointer else { return }
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let bps = Int(asbd.mBitsPerChannel)
        if isFloat && bps == 32 {
            let count = lengthOut / 4
            base.withMemoryRebound(to: Float.self, capacity: count) { p in
                for i in 0..<count {
                    let v = p[i] * gain
                    p[i] = v > 1 ? 1 : (v < -1 ? -1 : v)
                }
            }
        } else if !isFloat && bps == 16 {
            let count = lengthOut / 2
            base.withMemoryRebound(to: Int16.self, capacity: count) { p in
                let g = gain
                for i in 0..<count {
                    let scaled = Float(p[i]) * g
                    let clipped = scaled > 32767 ? 32767 : (scaled < -32768 ? -32768 : scaled)
                    p[i] = Int16(clipped)
                }
            }
        }
    }

    private func maybeEmitLevel(sourceId: String, sampleBuffer: CMSampleBuffer) {
        let now = Date().timeIntervalSince1970
        if let last = lastLevelAt[sourceId], now - last < 0.05 { return }
        lastLevelAt[sourceId] = now
        let rms = rmsLevel(of: sampleBuffer)
        emit(["event": "audio_level", "source_id": sourceId, "rms": rms])
    }

    // MARK: SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard CMSampleBufferIsValid(sampleBuffer),
              CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }
        switch type {
        case .screen:
            if let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
               let status = attachments.first?[.status] as? Int,
               status != SCFrameStatus.complete.rawValue {
                return
            }
            guard let writer = writer, let input = videoInput,
                  writer.status != .failed else { return }
            if !sessionStarted {
                let ts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                writer.startSession(atSourceTime: ts)
                sessionStarted = true
            }
            guard input.isReadyForMoreMediaData else { return }
            if let compositor = compositor, let adaptor = pixelAdaptor,
               let screenPB = CMSampleBufferGetImageBuffer(sampleBuffer) {
                let camPB = camera?.latestPixelBuffer
                if let composed = compositor.compose(screen: screenPB, camera: camPB) {
                    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                    adaptor.append(composed, withPresentationTime: pts)
                } else {
                    input.append(sampleBuffer)
                }
            } else {
                input.append(sampleBuffer)
            }
        case .audio:
            handleAudioBuffer(sourceId: "system", sampleBuffer: sampleBuffer)
        default:
            break
        }
    }

    /// RMS of a PCM audio sample buffer, in [0, 1]. Returns 0 for non-PCM or
    /// malformed buffers; we don't want level meters to mask real problems.
    private func rmsLevel(of sampleBuffer: CMSampleBuffer) -> Double {
        guard let fmt = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee
        else { return 0 }
        var abl = AudioBufferList()
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &abl,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer)
        guard status == noErr, let data = abl.mBuffers.mData else { return 0 }
        let byteCount = Int(abl.mBuffers.mDataByteSize)
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let bitsPerChannel = Int(asbd.mBitsPerChannel)
        var sumSquares = 0.0
        var sampleCount = 0
        if isFloat && bitsPerChannel == 32 {
            let count = byteCount / 4
            let ptr = data.assumingMemoryBound(to: Float.self)
            for i in 0..<count {
                let v = Double(ptr[i])
                sumSquares += v * v
            }
            sampleCount = count
        } else if !isFloat && bitsPerChannel == 16 {
            let count = byteCount / 2
            let ptr = data.assumingMemoryBound(to: Int16.self)
            for i in 0..<count {
                let v = Double(ptr[i]) / 32_768.0
                sumSquares += v * v
            }
            sampleCount = count
        } else {
            return 0
        }
        guard sampleCount > 0 else { return 0 }
        return (sumSquares / Double(sampleCount)).squareRoot()
    }

    // MARK: SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "message": "stream stopped: \(error.localizedDescription)"])
    }

    func stop() async -> String? {
        // cam-only has no SCStream but may still have an active writer/camera.
        if stream == nil && camera == nil { return outputPath }
        if let stream = stream {
            try? await stream.stopCapture()
        }
        self.stream = nil
        camera?.stop()
        camera = nil
        compositor = nil
        audioSession?.stopRunning()
        audioSession = nil
        micDelegates.removeAll()
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            writerQueue.async {
                self.videoInput?.markAsFinished()
                for input in self.audioInputs.values {
                    input.markAsFinished()
                }
                if let w = self.writer, w.status == .writing {
                    w.finishWriting { cont.resume() }
                } else {
                    cont.resume()
                }
            }
        }
        self.writer = nil
        self.videoInput = nil
        self.pixelAdaptor = nil
        self.audioInputs.removeAll()
        self.lastLevelAt.removeAll()
        self.sessionStarted = false
        return outputPath
    }
}
#endif

// MARK: - Permission probes
//
// We only check status here — never prompt — so the UI can decide when to
// escalate. Screen capture permission is inferred from CGPreflightScreenCaptureAccess
// when available; camera/mic are checked via AVCaptureDevice.

func probePermissions() -> [String: Any] {
    var result: [String: Any] = [
        "event": "permissions",
        "microphone": false,
        "camera": false,
        "screen": false,
    ]
    #if canImport(AVFoundation)
    let mic = AVCaptureDevice.authorizationStatus(for: .audio)
    result["microphone"] = (mic == .authorized)
    let cam = AVCaptureDevice.authorizationStatus(for: .video)
    result["camera"] = (cam == .authorized)
    #endif
    #if os(macOS)
    // CGPreflightScreenCaptureAccess() is only available on 10.15+.
    result["screen"] = CGPreflightScreenCaptureAccess()
    #endif
    return result
}

// MARK: - Device enumeration
//
// Lists displays, cameras and microphones the helper can record from. The
// returned identifiers are stable strings the UI round-trips back in `start`.

func listDisplays() -> [[String: Any]] {
    #if os(macOS)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        return []
    }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
        return []
    }
    var namesByNumber: [CGDirectDisplayID: String] = [:]
    for screen in NSScreen.screens {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        if let num = screen.deviceDescription[key] as? NSNumber {
            namesByNumber[CGDirectDisplayID(num.uint32Value)] = screen.localizedName
        }
    }
    return ids.map { id -> [String: Any] in
        let width = CGDisplayPixelsWide(id)
        let height = CGDisplayPixelsHigh(id)
        let name = namesByNumber[id] ?? "Display \(id)"
        return [
            "id": String(id),
            "name": name,
            "width": width,
            "height": height,
            "primary": CGDisplayIsMain(id) != 0,
        ]
    }
    #else
    return []
    #endif
}

func listCameras() -> [[String: Any]] {
    var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
    if #available(macOS 14.0, *) {
        types.append(.external)
        types.append(.continuityCamera)
    } else {
        types.append(.externalUnknown)
    }
    if #available(macOS 13.0, *) {
        types.append(.deskViewCamera)
    }
    let session = AVCaptureDevice.DiscoverySession(
        deviceTypes: types, mediaType: .video, position: .unspecified)
    return session.devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
}

func listMicrophones() -> [[String: Any]] {
    if #available(macOS 14.0, *) {
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified)
        return session.devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
    }
    // Older macOS: DiscoverySession has no audio device type that covers the
    // built-in mic, so fall back to the deprecated enumerator.
    let devices = AVCaptureDevice.devices(for: .audio)
    return devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
}

func devicesPayload() -> [String: Any] {
    return [
        "event": "devices",
        "displays": listDisplays(),
        "cameras": listCameras(),
        "microphones": listMicrophones(),
    ]
}

// MARK: - Main loop

#if os(macOS)
let recorder = ScreenRecorder()

// Serialise all recorder mutations on a single dispatch queue so start/stop
// can't race even when `start` is still finishing when `stop` arrives.
let opQueue = DispatchQueue(label: "stash.recorder.ops")

emit(["event": "ready", "pid": ProcessInfo.processInfo.processIdentifier])

// Read stdin line-by-line; each line is a JSON command.
while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    guard let data = line.data(using: .utf8) else {
        emitError("invalid utf-8 on stdin")
        continue
    }
    let cmd: Command
    do {
        cmd = try JSONDecoder().decode(Command.self, from: data)
    } catch {
        emitError("bad command json: \(error.localizedDescription)")
        continue
    }

    switch cmd.cmd {
    case "start":
        guard let output = cmd.output, !output.isEmpty else {
            emitError("start: missing output path")
            break
        }
        let mode = cmd.mode ?? "screen"
        let fps = cmd.fps ?? 60
        let displayId: CGDirectDisplayID? = cmd.display_id
            .flatMap { UInt32($0) }
        // Preserve legacy `mic: true` by falling back to the system default mic
        // when the caller hasn't supplied an explicit id list.
        var micIds = cmd.mic_ids ?? []
        if micIds.isEmpty, cmd.mic == true,
           let defaultMic = AVCaptureDevice.default(for: .audio) {
            micIds = [defaultMic.uniqueID]
        }
        let systemAudio = cmd.system_audio ?? false
        let cameraId = cmd.camera_id
        let overlay = cmd.cam_overlay
        let excluded = cmd.excluded_window_titles ?? []
        let gains = cmd.source_gains ?? [:]
        let muted = cmd.muted_sources ?? []
        opQueue.async {
            Task {
                do {
                    try await recorder.start(
                        output: output,
                        mode: mode,
                        displayId: displayId,
                        fps: fps,
                        micIds: micIds,
                        systemAudio: systemAudio,
                        cameraId: cameraId,
                        camOverlay: overlay,
                        excludedWindowTitles: excluded,
                        sourceGains: gains,
                        mutedSources: muted
                    )
                    emit(["event": "recording_started", "path": output])
                } catch {
                    emit(["event": "error",
                          "message": "start failed: \(error.localizedDescription)"])
                }
            }
        }

    case "stop":
        opQueue.async {
            Task {
                let path = await recorder.stop()
                emit(["event": "stopped", "path": path ?? ""])
            }
        }

    case "status":
        emit([
            "event": "status",
            "recording": recorder.isRecording,
            "path": recorder.outputPath ?? "",
        ])

    case "probe_permissions":
        emit(probePermissions())

    case "list_devices":
        emit(devicesPayload())

    case "quit", "exit":
        let sem = DispatchSemaphore(value: 0)
        Task {
            _ = await recorder.stop()
            sem.signal()
        }
        sem.wait()
        exit(0)

    default:
        emitError("unknown cmd: \(cmd.cmd)")
    }
}

// stdin closed — gracefully stop any in-progress capture.
let shutdownSem = DispatchSemaphore(value: 0)
Task {
    _ = await recorder.stop()
    shutdownSem.signal()
}
shutdownSem.wait()
#endif
