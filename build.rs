use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=frontend");
    println!("cargo:rerun-if-env-changed=SOURCE_REVISION");

    let revision = env::var("SOURCE_REVISION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(git_revision)
        .unwrap_or_else(|| "unknown".to_owned());

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"))
        .join("build_info.rs");
    let generated = format!(
        "pub const VERSION: &str = {:?};\npub const REVISION: &str = {:?};\npub const ASSET_VERSION: &str = {:?};\n",
        env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo"),
        revision,
        asset_version()
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

// Hash production names and bytes independently of Git metadata and dev files.
fn asset_version() -> String {
    fn visit(path: &Path, files: &mut Vec<PathBuf>) {
        if path.is_dir() {
            for entry in fs::read_dir(path).expect("read asset directory") {
                visit(&entry.expect("asset entry").path(), files);
            }
        } else if path.is_file() {
            let name = path.to_string_lossy().replace('\\', "/");
            let filename = path.file_name().unwrap().to_string_lossy();
            if filename == ".DS_Store"
                || filename.ends_with(".json")
                || filename.ends_with(".md")
                || filename.starts_with("README")
                || filename.starts_with("LICENSE")
                || filename.starts_with("REBUILD")
                || (name.contains("vendor/katex/fonts/")
                    && (name.ends_with(".ttf") || name.ends_with(".woff")))
                || ((name.contains("vendor/github-markdown-css/")
                    || name.contains("vendor/cdn-assets/"))
                    && name.ends_with(".css"))
            {
                return;
            }
            files.push(path.to_owned());
        }
    }
    let mut files = Vec::new();
    for root in [
        "frontend/index.html",
        "frontend/src",
        "frontend/views",
        "frontend/styles",
        "frontend/icons",
        "frontend/vendor",
    ] {
        visit(Path::new(root), &mut files);
    }
    files.sort();
    let mut hash = Sha256::new();
    for path in files {
        let name = path.to_string_lossy().replace('\\', "/");
        let bytes = fs::read(&path).expect("read asset bytes");
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
