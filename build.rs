use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // The web client that `FrontendAssets` embeds. rust-embed can't tell Cargo
    // about files added later, and a release build must embed them too.
    for root in ["index.html", "src", "views", "styles", "icons", "vendor"] {
        println!("cargo:rerun-if-changed=frontend/{root}");
    }
    println!("cargo:rerun-if-env-changed=SOURCE_REVISION");

    let revision = env::var("SOURCE_REVISION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(git_revision)
        .unwrap_or_else(|| "unknown".to_owned());

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"))
        .join("build_info.rs");
    let generated = format!(
        "pub const VERSION: &str = {:?};\npub const REVISION: &str = {:?};\n",
        env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo"),
        revision,
    );
    fs::write(output, generated).expect("write generated build metadata");
}

fn git_revision() -> Option<String> {
    let revision = git(&["rev-parse", "--short=12", "HEAD"])?;
    // Resolve worktree-specific HEAD and shared refs through Git itself. Never
    // watch the index: staging does not change the revision embedded here.
    let mut paths = vec!["HEAD".to_owned(), "packed-refs".to_owned()];
    if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"]) {
        // A packed branch has no loose ref yet. Watch its existing parent so
        // the next commit's newly created loose ref also invalidates metadata.
        if let Some(path) = git(&["rev-parse", "--git-path", &reference]) {
            let path = PathBuf::from(path);
            if !path.exists()
                && let Some(parent) = path.ancestors().skip(1).find(|p| p.is_dir())
            {
                println!("cargo:rerun-if-changed={}", parent.display());
            }
        }
        paths.push(reference);
    }
    for path in paths {
        if let Some(path) = git(&["rev-parse", "--git-path", &path])
            && PathBuf::from(&path).is_file()
        {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    Some(revision)
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
