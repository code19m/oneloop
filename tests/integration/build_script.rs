//! Exercise the actual build script without writing Git metadata or refs.

#[cfg(unix)]
mod script {
    include!("../../build.rs");
    pub fn run() {
        main();
    }
}

/// Entry point for the subprocess below, which gives the build script its own
/// environment and working directory.
#[cfg(unix)]
#[test]
#[ignore = "run only as a subprocess of the build script tests"]
fn build_script_subprocess() {
    if std::env::var_os("ONELOOP_BUILD_SCRIPT_FIXTURE").is_some() {
        script::run();
    }
}

#[cfg(unix)]
#[test]
fn metadata_watches_existing_git_paths_and_honors_source_revision() {
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};
    let root = crate::support::scratch_dir();
    let root = root.path().canonicalize().unwrap();
    for directory in [
        "frontend/src",
        "frontend/views",
        "frontend/styles",
        "frontend/icons",
        "frontend/vendor",
    ] {
        fs::create_dir_all(root.join(directory)).unwrap();
        fs::write(root.join(directory).join("fixture.js"), "fixture").unwrap();
    }
    let bin = root.join("bin");
    fs::create_dir(&bin).unwrap();
    let git = bin.join("git");
    // A worktree HEAD is separate from the shared branch ref and packed refs.
    fs::write(
        &git,
        r#"#!/bin/sh
case "$*" in
  'rev-parse --short=12 HEAD') echo 123456789abc ;;
  'symbolic-ref -q HEAD') [ "$DETACHED" != 1 ] && echo refs/heads/lane ;;
  'rev-parse --git-path HEAD') echo worktree/HEAD ;;
  'rev-parse --git-path packed-refs') echo shared/packed-refs ;;
  'rev-parse --git-path refs/heads/lane') echo shared/refs/heads/lane ;;
  *) exit 1 ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&git, fs::Permissions::from_mode(0o700)).unwrap();
    for path in [
        "worktree/HEAD",
        "shared/packed-refs",
        "shared/refs/heads/lane",
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "fixture").unwrap();
    }
    let run = |source: Option<&str>, detached: bool| {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "build_script::build_script_subprocess",
                "--ignored",
                "--nocapture",
            ])
            .env("ONELOOP_BUILD_SCRIPT_FIXTURE", "1");
        command
            .current_dir(&root)
            .env("PATH", &bin)
            .env("OUT_DIR", &root)
            .env("CARGO_PKG_VERSION", "1.2.3")
            .env_remove("SOURCE_REVISION")
            .env("DETACHED", if detached { "1" } else { "0" });
        if let Some(source) = source {
            command.env("SOURCE_REVISION", source);
        }
        let output = command.output().unwrap();
        assert!(output.status.success());
        (
            String::from_utf8(output.stdout).unwrap(),
            fs::read_to_string(root.join("build_info.rs")).unwrap(),
        )
    };
    let (output, metadata) = run(None, false);
    for path in [
        "worktree/HEAD",
        "shared/packed-refs",
        "shared/refs/heads/lane",
    ] {
        assert!(output.contains(&format!("cargo:rerun-if-changed={path}\n")));
    }
    assert!(!output.contains("index"));
    assert!(metadata.contains("123456789abc"));
    let (output, _) = run(None, true);
    assert!(!output.contains("shared/refs/heads/lane"));
    fs::remove_file(root.join("shared/refs/heads/lane")).unwrap();
    let (output, _) = run(None, false);
    assert!(output.contains("cargo:rerun-if-changed=shared/refs/heads\n"));
    assert!(!output.contains("cargo:rerun-if-changed=shared/refs/heads/lane\n"));
    fs::remove_file(root.join("shared/packed-refs")).unwrap();
    let (output, _) = run(None, false);
    assert!(!output.contains("packed-refs"));
    let (output, metadata) = run(Some("release-revision-dirty"), false);
    assert!(!output.contains("worktree/") && !output.contains("shared/"));
    assert!(metadata.contains("release-revision-dirty"));
    // Package exclusions must not alter the public cache identity. Production
    // bytes still invalidate it even when a source revision is supplied.
    fs::write(root.join("frontend/package.json"), "{}").unwrap();
    fs::write(root.join("frontend/vendor/audit.json"), "{}").unwrap();
    fs::write(root.join("frontend/views/README.md"), "Developer notes").unwrap();
    let (_, same_assets) = run(Some("release-revision-dirty"), false);
    assert_eq!(metadata, same_assets);
    fs::write(root.join("frontend/styles/fixture.js"), "changed bytes").unwrap();
    let (_, changed_assets) = run(Some("release-revision-dirty"), false);
    assert_ne!(metadata, changed_assets);
    // Source archives: Git may exist but fail, or be unavailable altogether.
    fs::write(&git, "#!/bin/sh\nexit 1\n").unwrap();
    for remove_git in [false, true] {
        if remove_git {
            fs::remove_file(&git).unwrap();
        }
        let (output, metadata) = run(None, false);
        assert!(!output.contains("worktree/") && !output.contains("shared/"));
        assert!(metadata.contains("unknown"));
    }
}
