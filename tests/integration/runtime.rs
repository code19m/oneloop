//! The `serve` process: startup, the single-server lock, logging and shutdown.

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    process::{Child, Command, Stdio},
    time::Duration,
};

use crate::support::{free_port, scratch_dir};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn piped_server_logs_use_plain_stderr_and_report_listening_and_stop() {
    let directory = scratch_dir();
    let command = |address: &str| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_oneloop"));
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("ONELOOP_") {
                command.env_remove(key);
            }
        }
        command
            .env("ONELOOP_DATA_DIR", directory.path())
            .env("ONELOOP_PUBLIC_URL", format!("http://{address}"))
            .env("ONELOOP_LISTEN", address)
            .env("ONELOOP_LOG_LEVEL", "debug");
        command
    };
    assert!(
        command("127.0.0.1:19899")
            .args(["db", "migrate"])
            .output()
            .unwrap()
            .status
            .success()
    );
    // The server logs "oneloop listening" after binding, so reading stderr up
    // to that line needs no polling. Another process may take the free port
    // first; then the server exits and the test tries the next port.
    let (mut server, mut stderr, mut log, address) = loop {
        let address = format!("127.0.0.1:{}", free_port());
        let mut server = Server(
            command(&address)
                .arg("serve")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut stderr = BufReader::new(server.0.stderr.take().unwrap());
        let mut log = String::new();
        while !log.contains("oneloop listening") && stderr.read_line(&mut log).unwrap() > 0 {}
        if log.contains("oneloop listening") {
            break (server, stderr, log, address);
        }
        assert!(
            log.contains("cannot listen on"),
            "server exited before listening: {log}"
        );
    };
    let mut stream = TcpStream::connect(&address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .write_all(
            format!("GET /healthz HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    let second = command(&format!("127.0.0.1:{}", free_port()))
        .arg("serve")
        .output()
        .unwrap();
    assert!(!second.status.success());
    assert!(
        String::from_utf8_lossy(&second.stderr).contains("another oneloop server is already using")
    );
    // Host account commands and preflight checks remain usable beside the server.
    assert!(
        command(&address)
            .args(["serve", "--check"])
            .output()
            .unwrap()
            .status
            .success()
    );

    #[cfg(unix)]
    {
        assert!(
            Command::new("kill")
                .args(["-TERM", &server.0.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
    }
    #[cfg(not(unix))]
    {
        server.0.kill().unwrap();
    }
    // Both pipes reach end of file when the process exits.
    stderr.read_to_string(&mut log).unwrap();
    let mut stdout = String::new();
    server
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    server.0.wait().unwrap();
    assert!(stdout.is_empty(), "runtime wrote to stdout: {stdout}");
    assert!(!log.contains('\x1b'));
    assert!(log.contains(&format!("sqlite_version=\"{}\"", rusqlite::version())));
    #[cfg(unix)]
    assert!(log.contains("oneloop stopped"), "{log}");
}
