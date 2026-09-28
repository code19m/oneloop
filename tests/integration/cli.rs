use std::collections::BTreeMap;

use assert_cmd::Command as ProcessCommand;
use clap::Parser;
use oneloop::cli::{Cli, Command};
use predicates::str::contains;

use crate::support::{data_dir, free_port, scratch_dir};

#[test]
fn cli_surface_is_small_and_has_no_inline_password_flag() {
    let cli = Cli::try_parse_from(["oneloop", "serve", "--check"]).unwrap();
    assert!(matches!(cli.command, Command::Serve(_)));

    let inline_password =
        Cli::try_parse_from(["oneloop", "user", "add", "taylorwu", "--password", "secret"]);
    assert!(inline_password.is_err());

    let missing_command = Cli::try_parse_from(["oneloop"]);
    assert!(missing_command.is_err());

    let accepted = BTreeMap::from([
        ("serve", ["oneloop", "serve", "--check"].as_slice()),
        (
            "user-add",
            ["oneloop", "user", "add", "taylorwu", "--admin"].as_slice(),
        ),
        (
            "user-passwd",
            ["oneloop", "user", "passwd", "taylorwu", "--password-stdin"].as_slice(),
        ),
        (
            "backup-create",
            ["oneloop", "backup", "create", "/tmp/backup"].as_slice(),
        ),
        (
            "backup-restore",
            ["oneloop", "backup", "restore", "/tmp/backup"].as_slice(),
        ),
        (
            "db-migrate",
            ["oneloop", "db", "migrate", "--backup-dir", "/tmp"].as_slice(),
        ),
    ]);
    for (name, arguments) in accepted {
        assert!(Cli::try_parse_from(arguments).is_ok(), "{name}");
    }
}

#[test]
fn binary_without_arguments_prints_help_successfully() {
    ProcessCommand::cargo_bin("oneloop")
        .unwrap()
        .assert()
        .success()
        .stdout(contains("Usage:"));
}

#[test]
fn serve_check_accepts_an_uninitialized_data_directory_without_creating_it() {
    let parent = scratch_dir();
    let data_dir = parent.path().join("not-created");
    ProcessCommand::cargo_bin("oneloop")
        .unwrap()
        .env_clear()
        .env("ONELOOP_PUBLIC_URL", "https://work.example.com")
        .env("ONELOOP_DATA_DIR", &data_dir)
        .args(["serve", "--check"])
        .assert()
        .success()
        .stdout(contains("database is not initialized"));
    assert!(!data_dir.exists());
}

#[cfg(unix)]
#[test]
fn serve_and_preflight_reject_readonly_database_and_name_the_path() {
    use std::{fs, os::unix::fs::PermissionsExt};
    let root = data_dir();
    let database = root.path().join("oneloop.sqlite3");
    fs::set_permissions(&database, fs::Permissions::from_mode(0o400)).unwrap();
    if fs::OpenOptions::new().write(true).open(&database).is_ok() {
        // Root can write despite chmod; this permission scenario does not apply.
        fs::set_permissions(database, fs::Permissions::from_mode(0o600)).unwrap();
        return;
    }
    let address = format!("127.0.0.1:{}", free_port());
    for args in [vec!["serve", "--check"], vec!["serve"]] {
        ProcessCommand::cargo_bin("oneloop")
            .unwrap()
            .env_clear()
            .env("ONELOOP_PUBLIC_URL", format!("http://{address}"))
            .env("ONELOOP_LISTEN", &address)
            .env("ONELOOP_DATA_DIR", root.path())
            .args(args)
            .assert()
            .code(1)
            .stderr(contains(database.to_string_lossy().as_ref()))
            .stderr(contains("not writable"));
    }
    fs::set_permissions(database, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn binary_migrates_backs_up_restores_and_reads_one_password_line() {
    let root = scratch_dir();
    let data = root.path().join("data");
    let backup = std::path::absolute(root.path().join("backup")).unwrap();
    let restored = std::path::absolute(root.path().join("restored")).unwrap();
    let command = |dir: &std::path::Path| {
        let mut command = ProcessCommand::cargo_bin("oneloop").unwrap();
        command.env_clear().env("ONELOOP_DATA_DIR", dir);
        command
    };
    let schema = oneloop::db::CURRENT_SCHEMA_VERSION;
    command(&data)
        .args(["db", "migrate"])
        .assert()
        .success()
        .stdout(format!("database migrated from 0 to {schema}\n"));
    command(&data)
        .args(["db", "migrate"])
        .assert()
        .success()
        .stdout(format!("database schema {schema} is current\n"));
    command(&data)
        .args(["user", "add", "owner", "--admin", "--password-stdin"])
        .write_stdin("pass123\r\n")
        .assert()
        .success()
        .stdout(contains("owner"));
    for (bytes, message) in [
        (b"a\nb\n".to_vec(), "exactly one line"),
        (vec![0xff, b'\n'], "valid UTF-8"),
    ] {
        command(&data)
            .args(["user", "passwd", "owner", "--password-stdin"])
            .write_stdin(bytes)
            .assert()
            .failure()
            .stderr(contains(message));
    }
    command(&data)
        .args(["user", "passwd", "owner"])
        .write_stdin("pass123\n")
        .assert()
        .failure()
        .stderr(contains("use --password-stdin"));
    command(&data)
        .args(["user", "passwd", "owner", "--password-stdin"])
        .write_stdin("pass456\r\n")
        .assert()
        .success()
        .stdout("password reset; existing credentials revoked\n");
    // Assert CRLF removal against the actual password hash, not just command exit.
    let connection = rusqlite::Connection::open(data.join("oneloop.sqlite3")).unwrap();
    let hash: String = connection
        .query_row(
            "SELECT password_hash FROM users WHERE username='owner'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(oneloop::auth::password::verify_password("pass456", &hash).unwrap());
    drop(connection);
    command(&data)
        .args(["backup", "create"])
        .arg(&backup)
        .assert()
        .success()
        .stdout(format!("backup created at {}\n", backup.display()));
    command(&restored)
        .args(["backup", "restore"])
        .arg(&backup)
        .assert()
        .success()
        .stdout(format!(
            "backup restored to {}; all restored credentials were revoked\n",
            restored.display()
        ));
    command(&restored)
        .args(["backup", "restore"])
        .arg(&backup)
        .assert()
        .failure();
    command(&restored)
        .env("ONELOOP_PUBLIC_URL", "http://127.0.0.1:19899")
        .args(["serve", "--check"])
        .assert()
        .success()
        .stdout(contains(format!(
            "IANA timezone database {}",
            chrono_tz::IANA_TZDB_VERSION
        )));
}
