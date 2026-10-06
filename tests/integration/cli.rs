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
        .stdout(contains("Usage:"))
        .stdout(contains("ONELOOP_DATA_DIR"));
}

#[test]
fn version_names_the_source_revision() {
    let version = match oneloop::build_info::REVISION {
        "unknown" => oneloop::build_info::VERSION.to_owned(),
        revision => format!("{} ({revision})", oneloop::build_info::VERSION),
    };
    ProcessCommand::cargo_bin("oneloop")
        .unwrap()
        .arg("--version")
        .assert()
        .success()
        .stdout(format!("oneloop {version}\n"));
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
        // deploy/launchd/oneloop-launchd.sh stops the job when it sees this.
        .stdout(contains("database is not initialized"));
    assert!(!data_dir.exists());
}

/// The launchd launcher and the systemd unit in deploy/ stop instead of
/// restarting when oneloop exits with 2, because a restart can't fix a setting.
#[test]
fn serve_exits_with_2_on_an_invalid_setting() {
    let data_dir = scratch_dir();
    for arguments in [["serve", "--check"].as_slice(), ["serve"].as_slice()] {
        ProcessCommand::cargo_bin("oneloop")
            .unwrap()
            .env_clear()
            .env("ONELOOP_PUBLIC_URL", "https://work.example.com")
            .env("ONELOOP_DATA_DIR", data_dir.path())
            .env("ONELOOP_PORT", "8080")
            .args(arguments)
            .assert()
            .code(2)
            .stdout("")
            .stderr(contains("unknown environment variable ONELOOP_PORT"));
    }
}

#[cfg(unix)]
#[test]
fn data_paths_follow_symlinks_before_parent_components() {
    let root = scratch_dir();
    let actual = root.path().join("actual");
    let lexical = root.path().join("lexical");
    std::fs::create_dir_all(actual.join("child")).unwrap();
    std::fs::create_dir(&lexical).unwrap();
    std::os::unix::fs::symlink(actual.join("child"), lexical.join("alias")).unwrap();
    for suffix in ["", "new/instance"] {
        let supplied = lexical.join("alias/..").join(suffix);
        let mut expected = actual.canonicalize().unwrap();
        if !suffix.is_empty() {
            expected.push(suffix);
        }
        ProcessCommand::cargo_bin("oneloop")
            .unwrap()
            .env_clear()
            .env("ONELOOP_DATA_DIR", &supplied)
            .env("ONELOOP_PUBLIC_URL", "http://127.0.0.1:18710")
            .args(["serve", "--check"])
            .assert()
            .success()
            .stdout(contains(format!("data {}", expected.display())));
        assert!(!expected.join("oneloop.sqlite3").exists());
        ProcessCommand::cargo_bin("oneloop")
            .unwrap()
            .env_clear()
            .env("ONELOOP_DATA_DIR", &supplied)
            .args(["db", "migrate"])
            .assert()
            .success();
        assert!(expected.join("oneloop.sqlite3").is_file());
        assert!(!lexical.join(suffix).join("oneloop.sqlite3").exists());
    }
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
        .stdout(format!(
            "created a new database in {} (schema {schema})\n",
            data.display()
        ))
        .stderr("");
    command(&data)
        .args(["db", "migrate"])
        .assert()
        .success()
        .stdout(format!(
            "database in {} is current (schema {schema})\n",
            data.display()
        ))
        .stderr("");
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
        .code(2)
        .stderr(contains(
            "no terminal to ask for the password; use --password-stdin",
        ));
    command(&data)
        .args(["user", "add", "nameless", "--name", " ", "--password-stdin"])
        .write_stdin("pass123\n")
        .assert()
        .code(2)
        .stderr(contains("invalid --name:"));
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
    // Without a server zoneinfo, the built-in timezone database applies.
    command(&restored)
        .env("ONELOOP_PUBLIC_URL", "http://127.0.0.1:19899")
        .env("TZDIR", root.path())
        .args(["serve", "--check"])
        .assert()
        .success()
        .stdout(contains(format!(
            "IANA timezone database {} (built in)",
            oneloop::timezone::built_in_version()
        )));
}

#[test]
fn upgrade_messages_lead_to_a_command_that_works() {
    let root = scratch_dir();
    let data = root.path().join("data");
    let backups = root.path().join("backups");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir(&backups).unwrap();
    drop(crate::support::schema_two_database(&data));
    let command = || {
        let mut command = ProcessCommand::cargo_bin("oneloop").unwrap();
        command
            .env_clear()
            .env("ONELOOP_DATA_DIR", &data)
            .env("ONELOOP_PUBLIC_URL", "http://127.0.0.1:18710");
        command
    };
    command()
        .args(["serve", "--check"])
        .assert()
        .code(1)
        .stdout("")
        .stderr(contains(format!(
            "requires migration to {}; run `oneloop db migrate --backup-dir <folder>`",
            oneloop::db::CURRENT_SCHEMA_VERSION
        )));
    command()
        .args(["db", "migrate"])
        .assert()
        .code(1)
        .stderr(contains("--backup-dir is required"));
    let output = command()
        .args(["db", "migrate", "--backup-dir"])
        .arg(&backups)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines = stdout.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 2, "{stdout}");
    assert_eq!(
        lines[0],
        format!(
            "database in {} migrated from 2 to {}",
            data.display(),
            oneloop::db::CURRENT_SCHEMA_VERSION
        )
    );
    let backup = lines[1].strip_prefix("pre-upgrade backup: ").unwrap();
    oneloop::db::validate_backup(backup).unwrap();
}

#[test]
fn commands_on_an_empty_data_folder_say_how_to_fix_it() {
    let root = scratch_dir();
    ProcessCommand::cargo_bin("oneloop")
        .unwrap()
        .env_clear()
        .env("ONELOOP_DATA_DIR", root.path())
        .args(["user", "passwd", "owner", "--password-stdin"])
        .write_stdin("pass123\n")
        .assert()
        .code(1)
        .stdout("")
        .stderr(contains(format!(
            "database is not initialized at {}; check ONELOOP_DATA_DIR, or run `oneloop db migrate` to create a new instance",
            root.path().join("oneloop.sqlite3").display()
        )));
}

#[test]
fn metadata_documents_need_trusted_certificate_authorities_to_start() {
    let root = scratch_dir();
    let empty = root.path().join("no-authorities.pem");
    std::fs::write(&empty, "").unwrap();
    let command = |documents: &str, authorities: &std::path::Path| {
        let mut command = ProcessCommand::cargo_bin("oneloop").unwrap();
        command
            .env_clear()
            .env("ONELOOP_PUBLIC_URL", "http://127.0.0.1:18820")
            .env("ONELOOP_DATA_DIR", root.path().join("data"))
            .env("ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS", documents)
            .env("SSL_CERT_FILE", authorities)
            .args(["serve", "--check"]);
        command
    };
    command("true", &empty)
        .assert()
        .code(2)
        .stderr(contains("ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS is true"))
        .stderr(contains("no trusted certificate authorities"));
    // Off, the setting needs nothing.
    command("false", &empty).assert().success();
}

/// Scripts such as `oneloop serve --check | grep -q valid` stop reading after
/// the first match. The command has done its work by then.
#[cfg(unix)]
#[test]
fn output_to_a_reader_that_stopped_is_not_an_error() {
    let root = scratch_dir();
    for arguments in [["db", "migrate"], ["serve", "--check"]] {
        let (reader, writer) = std::io::pipe().unwrap();
        // With no reader left, every write to standard output fails.
        drop(reader);
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_oneloop"))
            .env_clear()
            .env("ONELOOP_PUBLIC_URL", "http://127.0.0.1:18730")
            .env("ONELOOP_DATA_DIR", root.path())
            .args(arguments)
            .stdout(writer)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{arguments:?}: {stderr}");
        assert_eq!(stderr, "", "{arguments:?}");
    }
    assert!(root.path().join("oneloop.sqlite3").is_file());
    // Help, with no arguments at all.
    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_oneloop"))
        .env_clear()
        .stdout(writer)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    // An error keeps its exit code when nothing reads standard error.
    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_oneloop"))
        .env_clear()
        .args(["serve", "--check"])
        .stderr(writer)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
}

/// The password that `user add` and `user passwd` set must be replaced at the
/// next sign-in, also by an admin who resets their own (troubleshooting.md).
#[test]
fn user_help_says_that_the_password_is_temporary() {
    for (arguments, summary) in [
        (["user", "--help"].as_slice(), "Set a temporary password"),
        (
            ["user", "add", "--help"].as_slice(),
            "The password you set is temporary",
        ),
        (
            ["user", "passwd", "--help"].as_slice(),
            "new password at their next sign-in",
        ),
    ] {
        ProcessCommand::cargo_bin("oneloop")
            .unwrap()
            .args(arguments)
            .assert()
            .success()
            .stdout(contains(summary));
    }
}
