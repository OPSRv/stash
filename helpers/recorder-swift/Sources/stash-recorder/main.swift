import Foundation
import AVFoundation
#if os(macOS)
import AppKit
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
//
// Outgoing events:
//   { "event": "ready", "pid": 1234 }
//   { "event": "recording_started", "path": "/path/to/out.mov" }
//   { "event": "stopped", "path": "/path/to/out.mov" }
//   { "event": "error", "message": "..." }
//   { "event": "status", "recording": true, "path": "..." }
//   { "event": "permissions",
//     "screen": true, "microphone": false, "camera": false }

struct StartArgs: Decodable {
    let mode: String?
    let mic: Bool?
    let display_id: String?
    let fps: Int?
    let output: String
}

struct Command: Decodable {
    let cmd: String
    let mode: String?
    let mic: Bool?
    let display_id: String?
    let fps: Int?
    let output: String?
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

// MARK: - Screen recorder (backed by `screencapture -v`)
//
// This is a v0 implementation. The command-line `screencapture -v` is built
// into macOS, supports silent start, and can be terminated gracefully to
// flush the .mov file. It avoids ScreenCaptureKit delegate boilerplate while
// we ship the rest of the pipeline.
//
// TODO(recorder): replace with ScreenCaptureKit + AVAssetWriter for custom
// resolutions, 60fps, audio mixing and PiP webcam composition.

final class ScreenRecorder {
    private var process: Process?
    private(set) var outputPath: String?

    var isRecording: Bool { process?.isRunning ?? false }

    func start(output: String, includeMic: Bool) throws {
        guard process?.isRunning != true else {
            throw NSError(domain: "stash-recorder", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "already recording"])
        }
        let fm = FileManager.default
        let dir = (output as NSString).deletingLastPathComponent
        if !fm.fileExists(atPath: dir) {
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        var args = ["-v", "-x"] // -v: video, -x: silent (no sound effects)
        if includeMic {
            args.append("-g") // capture microphone
        }
        args.append(output)
        p.arguments = args
        // Silence the helper's stdout/stderr so it never pollutes our JSON
        // protocol channel.
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        try p.run()
        self.process = p
        self.outputPath = output
    }

    func stop() -> String? {
        guard let p = process, p.isRunning else { return outputPath }
        // `screencapture -v` finalises the file gracefully on SIGINT.
        p.interrupt()
        p.waitUntilExit()
        self.process = nil
        return outputPath
    }
}

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

// MARK: - Main loop

let recorder = ScreenRecorder()

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
        do {
            try recorder.start(output: output, includeMic: cmd.mic ?? false)
            emit(["event": "recording_started", "path": output])
        } catch {
            emitError("start failed: \(error.localizedDescription)")
        }

    case "stop":
        let path = recorder.stop()
        emit(["event": "stopped", "path": path ?? ""])

    case "status":
        emit([
            "event": "status",
            "recording": recorder.isRecording,
            "path": recorder.outputPath ?? "",
        ])

    case "probe_permissions":
        emit(probePermissions())

    case "quit", "exit":
        _ = recorder.stop()
        exit(0)

    default:
        emitError("unknown cmd: \(cmd.cmd)")
    }
}

// stdin closed — gracefully stop any in-progress capture.
_ = recorder.stop()
