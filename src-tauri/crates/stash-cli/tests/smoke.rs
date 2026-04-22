//! End-to-end smoke test for the `stash` binary.
//!
//! Spins a tiny UnixListener in the test, points `stash` at it via the
//! `STASH_IPC_SOCK` override, and asserts the wire interaction +
//! stdout / exit code. Intentionally does NOT depend on any Stash
//! app code — it exercises only the binary's client surface.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::Command;
use std::thread;

fn cargo_bin_path() -> std::path::PathBuf {
    // `CARGO_BIN_EXE_<name>` is set by Cargo when running integration
    // tests — points at the compiled binary for this crate.
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_stash"))
}

#[test]
fn stash_ok_response_prints_text_and_exits_zero() {
    let dir = tempdir();
    let sock = dir.path().join("ipc.sock");
    let listener = UnixListener::bind(&sock).unwrap();

    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("\"cmd\":\"status\""));
        stream
            .write_all(b"{\"ok\":true,\"text\":\"online\"}\n")
            .unwrap();
    });

    let output = Command::new(cargo_bin_path())
        .arg("status")
        .env("STASH_IPC_SOCK", &sock)
        .output()
        .unwrap();
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(0), "stderr: {:?}", output.stderr);
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "online");
}

#[test]
fn stash_err_response_exits_one() {
    let dir = tempdir();
    let sock = dir.path().join("ipc.sock");
    let listener = UnixListener::bind(&sock).unwrap();

    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        stream
            .write_all(b"{\"ok\":false,\"error\":\"boom\"}\n")
            .unwrap();
    });

    let output = Command::new(cargo_bin_path())
        .arg("anything")
        .env("STASH_IPC_SOCK", &sock)
        .output()
        .unwrap();
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("boom"), "stderr: {stderr}");
}

#[test]
fn stash_exits_two_when_socket_missing() {
    let dir = tempdir();
    let missing = dir.path().join("does-not-exist.sock");

    let output = Command::new(cargo_bin_path())
        .arg("status")
        .env("STASH_IPC_SOCK", &missing)
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("not running"), "stderr: {stderr}");
}

#[test]
fn stash_json_flag_prints_raw_response() {
    let dir = tempdir();
    let sock = dir.path().join("ipc.sock");
    let listener = UnixListener::bind(&sock).unwrap();

    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        stream
            .write_all(b"{\"ok\":true,\"text\":\"hi\"}\n")
            .unwrap();
    });

    let output = Command::new(cargo_bin_path())
        .args(["--json", "status"])
        .env("STASH_IPC_SOCK", &sock)
        .output()
        .unwrap();
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.trim_start().starts_with('{'), "stdout: {stdout}");
    assert!(stdout.contains("\"ok\":true"));
}

#[test]
fn stash_json_flag_exits_one_when_response_not_ok() {
    let dir = tempdir();
    let sock = dir.path().join("ipc.sock");
    let listener = UnixListener::bind(&sock).unwrap();

    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        stream
            .write_all(b"{\"ok\":false,\"error\":\"nope\"}\n")
            .unwrap();
    });

    let output = Command::new(cargo_bin_path())
        .args(["--json", "anything"])
        .env("STASH_IPC_SOCK", &sock)
        .output()
        .unwrap();
    server.join().unwrap();

    // Raw JSON still printed on stdout, but exit reflects the failure.
    assert_eq!(output.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"ok\":false"), "stdout: {stdout}");
}

#[test]
fn stash_preserves_argument_boundaries_in_request() {
    let dir = tempdir();
    let sock = dir.path().join("ipc.sock");
    let listener = UnixListener::bind(&sock).unwrap();

    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        // The request must carry a Vec with the original two strings,
        // not just the lossy joined `args_text`.
        assert!(
            line.contains("\"args\":[\"a b\",\"c d\"]"),
            "request line: {line}"
        );
        stream.write_all(b"{\"ok\":true,\"text\":\"ok\"}\n").unwrap();
    });

    let output = Command::new(cargo_bin_path())
        .args(["cmd", "a b", "c d"])
        .env("STASH_IPC_SOCK", &sock)
        .output()
        .unwrap();
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(0), "stderr: {:?}", output.stderr);
}

#[test]
fn stash_does_not_consume_json_flag_after_command_name() {
    // `--json` appearing inside the payload must reach the server
    // verbatim rather than flipping raw-output mode.
    let dir = tempdir();
    let sock = dir.path().join("ipc.sock");
    let listener = UnixListener::bind(&sock).unwrap();

    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(
            line.contains("--json"),
            "server did not receive --json in args: {line}"
        );
        stream
            .write_all(b"{\"ok\":true,\"text\":\"saved\"}\n")
            .unwrap();
    });

    let output = Command::new(cargo_bin_path())
        .args(["note", "think about --json design"])
        .env("STASH_IPC_SOCK", &sock)
        .output()
        .unwrap();
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(0), "stderr: {:?}", output.stderr);
    // Not raw mode — plain text print.
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "saved");
}

#[test]
fn stash_version_flag_prints_version_and_exits_zero() {
    let output = Command::new(cargo_bin_path())
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.starts_with("stash "), "stdout: {stdout}");
}

#[test]
fn stash_missing_command_exits_three_as_usage_error() {
    // Usage error is distinct from "app not running" (2) and "command
    // failed" (1) so scripts can tell them apart.
    let output = Command::new(cargo_bin_path()).output().unwrap();
    assert_eq!(output.status.code(), Some(3));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("usage:"), "stderr: {stderr}");
}

// Minimal tempdir that cleans itself up on Drop. Pulling `tempfile` as a
// dev-dep would be fine too — keeping this test crate deps at zero is a
// stylistic choice, not a requirement.
struct TempDir(std::path::PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
impl TempDir {
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
fn tempdir() -> TempDir {
    let base = std::env::temp_dir();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let p = base.join(format!("stash-cli-test-{nonce}"));
    std::fs::create_dir_all(&p).unwrap();
    TempDir(p)
}
