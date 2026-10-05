//! Runs the `git` program against a repository host. Every run gets a private
//! home, configuration and working copy; only HTTPS and SSH are allowed; Git
//! never prompts; and time, output and sizes are bounded. Credentials never
//! appear in command arguments.

use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    time::Instant,
};
use zeroize::Zeroizing;

use super::source::GitUrl;
use crate::files::disk::DiskReservation;

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const SYNC_TIMEOUT: Duration = Duration::from_secs(300);
const HISTORY_TIMEOUT: Duration = Duration::from_secs(60);
const OUTPUT_LIMIT: u64 = 64 * 1024 * 1024;
/// How often a download's working copy is measured against its budget.
const WATCH_INTERVAL: Duration = Duration::from_millis(250);
const ERROR_OUTPUT_LIMIT: u64 = 64 * 1024;
const PATH_MAX: usize = 1_024;
/// `GIT_CONFIG_COUNT` arrived in Git 2.31.
const MINIMUM_VERSION: (u32, u32) = (2, 31);

/// Environment Git may need from the server: the program path, temporary
/// files, proxies and the certificate authorities trusted for HTTPS.
const PASSTHROUGH: [&str; 14] = [
    "PATH",
    "TMPDIR",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "GIT_SSL_CAINFO",
    "GIT_SSL_CAPATH",
];

pub(crate) enum Credentials {
    None,
    Token {
        username: String,
        token: Zeroizing<String>,
    },
    DeployKey(Zeroizing<String>),
}

/// Why a sync failed, in terms an administrator can act on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    GitUnavailable,
    AuthFailed,
    NotFound,
    Moved,
    BranchNotFound,
    FolderNotFound,
    Unreachable,
    Certificate,
    HostKey,
    TooLarge,
    Timeout,
    StorageFull,
    CredentialsUnavailable,
    Failed,
}

impl Failure {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::GitUnavailable => "git_unavailable",
            Self::AuthFailed => "auth_failed",
            Self::NotFound => "repository_not_found",
            Self::Moved => "repository_moved",
            Self::BranchNotFound => "branch_not_found",
            Self::FolderNotFound => "folder_not_found",
            Self::Unreachable => "host_unreachable",
            Self::Certificate => "certificate_untrusted",
            Self::HostKey => "host_key_changed",
            Self::TooLarge => "too_large",
            Self::Timeout => "timeout",
            Self::StorageFull => "storage_full",
            Self::CredentialsUnavailable => "credentials_unavailable",
            Self::Failed => "sync_failed",
        }
    }
}

#[derive(Debug)]
pub(crate) struct SyncError {
    pub(crate) failure: Failure,
    /// For the server log only; never shown to users.
    pub(crate) detail: String,
}

impl SyncError {
    pub(crate) fn new(failure: Failure, detail: impl Into<String>) -> Self {
        Self {
            failure,
            detail: detail.into(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub(crate) max_files: usize,
    pub(crate) max_file_bytes: u64,
    pub(crate) max_total_bytes: u64,
    /// Bytes a sync may write to its working copy, oversized files included.
    pub(crate) max_download_bytes: u64,
}

pub(crate) struct SnapshotOptions {
    pub(crate) limits: Limits,
    pub(crate) history_depth: u32,
}

pub(crate) struct Snapshot {
    pub(crate) commit: String,
    /// Commit time of the branch tip.
    pub(crate) committed_at: i64,
    pub(crate) files: Vec<SnapshotFile>,
    /// Files left out because each is larger than the per-file limit.
    pub(crate) skipped: usize,
}

pub(crate) struct SnapshotFile {
    /// Relative to the folder.
    pub(crate) path: String,
    /// The latest commit in the fetched history that changed the file.
    pub(crate) changed_at: Option<i64>,
    pub(crate) content: Vec<u8>,
}

#[derive(Clone)]
pub(crate) struct Git {
    work_root: PathBuf,
    known_hosts: PathBuf,
    allow_file: bool,
    #[cfg(test)]
    counts: std::sync::Arc<Counts>,
}

/// Work done by one `Git`, for tests that bound it.
#[cfg(test)]
#[derive(Default)]
struct Counts {
    /// Git programs started.
    processes: std::sync::atomic::AtomicUsize,
    /// Working-copy measurements after bounded phases, besides the watchdog's.
    phase_walks: std::sync::atomic::AtomicUsize,
}

/// One run's private directory, credentials and the host a token may reach.
struct Session<'a> {
    disk: Option<DiskReservation>,
    root: PathBuf,
    home: PathBuf,
    global_config: PathBuf,
    hooks: PathBuf,
    templates: PathBuf,
    ssh_key: Option<PathBuf>,
    credentials: &'a Credentials,
    origin: Option<String>,
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        // A working copy can hold thousands of files; remove it off the
        // async workers when a runtime is there.
        let root = std::mem::take(&mut self.root);
        if root.as_os_str().is_empty() {
            return;
        }
        let disk = self.disk.take();
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn_blocking(move || {
                let _disk = disk;
                std::fs::remove_dir_all(root)
            })),
            Err(_) => drop(std::fs::remove_dir_all(root)),
        }
    }
}

impl Session<'_> {
    async fn cleanup(mut self) -> Result<(), SyncError> {
        let root = self.root.clone();
        let disk = self.disk.clone();
        tokio::task::spawn_blocking(move || {
            let _disk = disk;
            std::fs::remove_dir_all(root)
        })
        .await
        .map_err(|error| SyncError::new(Failure::Failed, format!("remove working copy: {error}")))?
        .map_err(|error| {
            SyncError::new(Failure::Failed, format!("remove working copy: {error}"))
        })?;
        self.root.clear();
        Ok(())
    }
}

struct Output {
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
}

/// A running `git`. The helpers it starts, such as `git-remote-https`, `ssh`
/// and `index-pack`, share its process group, and outlive it when only `git`
/// is killed. So a time limit, the size watchdog or a changed source stops the
/// whole group.
struct GitProcess {
    child: Option<Child>,
    disk: Option<DiskReservation>,
}

impl Drop for GitProcess {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        // Until Git is waited for, its process ID can't be reused, so the
        // group is still Git's own.
        #[cfg(unix)]
        if let Some(pid) = child
            .id()
            .and_then(|id| rustix::process::Pid::from_raw(i32::try_from(id).ok()?))
        {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
        if child.id().is_some() {
            let _ = child.start_kill();
            let disk = self.disk.take();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _disk = disk;
                    let _ = child.wait().await;
                });
            }
        }
    }
}

impl Git {
    pub(crate) fn new(work_root: PathBuf, known_hosts: PathBuf, allow_file: bool) -> Self {
        Self {
            work_root,
            known_hosts,
            allow_file,
            #[cfg(test)]
            counts: std::sync::Arc::default(),
        }
    }

    /// Remove working copies left by an interrupted process.
    pub(crate) fn clear_work_root(&self) -> std::io::Result<()> {
        match std::fs::remove_dir_all(&self.work_root) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// The commit the branch points to on the host.
    pub(crate) async fn remote_head(
        &self,
        url: &GitUrl,
        branch: &str,
        credentials: &Credentials,
        reservation: DiskReservation,
    ) -> Result<String, SyncError> {
        let deadline = Instant::now() + CHECK_TIMEOUT;
        let session = self.session(url, credentials, Some(reservation))?;
        self.require_version(&session, deadline).await?;
        let reference = format!("refs/heads/{branch}");
        let listing = self
            .run(
                &session,
                &[
                    "ls-remote",
                    "--heads",
                    "--refs",
                    "--",
                    &url.fetch_url(),
                    &reference,
                ],
                deadline,
            )
            .await?;
        String::from_utf8_lossy(&listing)
            .lines()
            .filter_map(|line| line.split_once('\t'))
            .find(|(_, name)| *name == reference)
            .map(|(commit, _)| commit.trim().to_owned())
            .filter(|commit| is_object_id(commit))
            .ok_or_else(|| SyncError::new(Failure::BranchNotFound, "the branch is not on the host"))
    }

    /// The files under `folder` at the tip of `branch`. With a host that
    /// supports partial clones, up to `history_depth` commits are fetched
    /// without file contents to find when each file last changed.
    pub(crate) async fn snapshot(
        &self,
        url: &GitUrl,
        branch: &str,
        folder: &str,
        credentials: &Credentials,
        options: SnapshotOptions,
        reservation: DiskReservation,
    ) -> Result<Snapshot, SyncError> {
        let SnapshotOptions {
            limits,
            history_depth,
        } = options;
        let deadline = Instant::now() + SYNC_TIMEOUT;
        let session = self.session(url, credentials, Some(reservation))?;
        self.require_version(&session, deadline).await?;
        let repository = session.root.join("repository");
        let repository_arg = repository.to_string_lossy().into_owned();
        let budget = limits.max_download_bytes;
        self.within(
            &session.root,
            budget,
            self.run(
                &session,
                &[
                    "clone",
                    "--quiet",
                    "--no-checkout",
                    "--filter=blob:none",
                    "--depth=1",
                    "--single-branch",
                    "--no-tags",
                    "--branch",
                    branch,
                    "--",
                    &url.fetch_url(),
                    &repository_arg,
                ],
                deadline,
            ),
        )
        .await?;

        let tip = self
            .run(
                &session,
                &in_repository(&repository_arg, &["log", "-1", "--format=%H %ct", "HEAD"]),
                deadline,
            )
            .await?;
        let (commit, committed_at) = String::from_utf8_lossy(&tip)
            .trim()
            .split_once(' ')
            .and_then(|(commit, time)| Some((commit.to_owned(), time.parse::<i64>().ok()?)))
            .filter(|(commit, _)| is_object_id(commit))
            .ok_or_else(|| SyncError::new(Failure::Failed, "the branch tip is not a commit"))?;

        if !folder.is_empty() {
            let listing = self
                .run(
                    &session,
                    &in_repository(
                        &repository_arg,
                        &["ls-tree", "-d", "--name-only", "HEAD", "--", folder],
                    ),
                    deadline,
                )
                .await?;
            if listing.is_empty() {
                return Err(SyncError::new(
                    Failure::FolderNotFound,
                    "the folder is not on the branch",
                ));
            }
        }
        let pathspec = if folder.is_empty() { "." } else { folder };
        let listing = self
            .run(
                &session,
                &in_repository(
                    &repository_arg,
                    &["ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", pathspec],
                ),
                deadline,
            )
            .await?;
        let selected = select_files(&listing, folder, limits.max_files)?;

        // Check out only the folder. Git fetches its file contents in one batch.
        let pattern = if folder.is_empty() {
            "/*\n".to_owned()
        } else {
            format!("/{}/\n", escape_pattern(folder))
        };
        let info = repository.join(".git").join("info");
        crate::db::create_private_directories(&info)
            .and_then(|()| std::fs::write(info.join("sparse-checkout"), pattern))
            .map_err(|error| {
                SyncError::new(Failure::Failed, format!("write sparse checkout: {error}"))
            })?;
        self.within(
            &session.root,
            budget,
            self.run(
                &session,
                &in_repository(&repository_arg, &["reset", "--quiet", "--hard", "HEAD"]),
                deadline,
            ),
        )
        .await?;

        let partial = self
            .output(
                &session,
                &in_repository(
                    &repository_arg,
                    &["config", "--get", "remote.origin.promisor"],
                ),
                deadline,
            )
            .await?
            .stdout
            .starts_with(b"true");
        let deepened = history_depth > 1 && partial && {
            let history_deadline = deadline.min(Instant::now() + HISTORY_TIMEOUT);
            let deepen = format!("--deepen={}", history_depth - 1);
            let result = self
                .within(
                    &session.root,
                    budget,
                    self.output(
                        &session,
                        &in_repository(&repository_arg, &["fetch", "--quiet", &deepen, "origin"]),
                        history_deadline,
                    ),
                )
                .await;
            match result {
                Err(error) if error.failure == Failure::TooLarge => return Err(error),
                result => result.is_ok_and(|output| output.success),
            }
        };
        let mut changed_at = HashMap::new();
        if deepened || history_depth <= 1 {
            let history = self
                .output(
                    &session,
                    &in_repository(
                        &repository_arg,
                        &[
                            "log",
                            "--format=%x1e%ct",
                            "--name-only",
                            "--no-renames",
                            "HEAD",
                            "--",
                            pathspec,
                        ],
                    ),
                    deadline,
                )
                .await?;
            if history.success {
                changed_at = change_times(&history.stdout);
            }
        }

        let (mut files, skipped) = self
            .within(
                &session.root,
                budget,
                self.read_blobs(&session, &repository_arg, selected, limits, deadline),
            )
            .await?;
        for file in &mut files {
            let repository_path = if folder.is_empty() {
                file.path.clone()
            } else {
                format!("{folder}/{}", file.path)
            };
            file.changed_at = changed_at.get(&repository_path).copied();
        }
        // Release temporary bytes before SQLite can write both WAL and data pages.
        session.cleanup().await?;
        Ok(Snapshot {
            commit,
            committed_at,
            files,
            skipped,
        })
    }

    async fn require_version(
        &self,
        session: &Session<'_>,
        deadline: Instant,
    ) -> Result<(), SyncError> {
        let output = self.output(session, &["version"], deadline).await?;
        let version = String::from_utf8_lossy(&output.stdout);
        match parse_version(&version) {
            Some(found) if found >= MINIMUM_VERSION => Ok(()),
            _ => Err(SyncError::new(
                Failure::GitUnavailable,
                format!("Git 2.31 or later is required; found {}", version.trim()),
            )),
        }
    }

    fn session<'a>(
        &self,
        url: &GitUrl,
        credentials: &'a Credentials,
        disk: Option<DiskReservation>,
    ) -> Result<Session<'a>, SyncError> {
        let io = |error: std::io::Error| {
            SyncError::new(Failure::Failed, format!("prepare working copy: {error}"))
        };
        let root = self.work_root.join(uuid::Uuid::now_v7().to_string());
        if let Some(disk) = &disk {
            disk.keep_until_removed(root.clone());
        }
        let session = Session {
            disk,
            home: root.join("home"),
            global_config: root.join("gitconfig"),
            hooks: root.join("hooks"),
            templates: root.join("templates"),
            ssh_key: matches!(credentials, Credentials::DeployKey(_)).then(|| root.join("id")),
            root,
            credentials,
            origin: url.origin(),
        };
        for directory in [&session.home, &session.hooks, &session.templates] {
            crate::db::create_private_directories(directory).map_err(io)?;
        }
        if let Some(parent) = self.known_hosts.parent() {
            crate::db::create_private_directories(parent).map_err(io)?;
        }
        write_private(&session.global_config, b"").map_err(io)?;
        if let (Credentials::DeployKey(key), Some(path)) = (credentials, &session.ssh_key) {
            write_private(path, key.as_bytes()).map_err(io)?;
        }
        Ok(session)
    }

    fn command(&self, session: &Session<'_>) -> Command {
        let mut command = Command::new("git");
        command.env_clear();
        for name in PASSTHROUGH {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("HOME", &session.home)
            .env("XDG_CONFIG_HOME", session.home.join(".config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", &session.global_config)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env(
                "GIT_ALLOW_PROTOCOL",
                if self.allow_file {
                    "https:ssh:file"
                } else {
                    "https:ssh"
                },
            )
            .env("LC_ALL", "C")
            .env("LANG", "C");
        let mut settings: Vec<(String, OsString)> = [
            ("credential.helper", OsString::new()),
            ("core.hooksPath", session.hooks.clone().into_os_string()),
            (
                "init.templateDir",
                session.templates.clone().into_os_string(),
            ),
            ("core.sparseCheckout", "true".into()),
            ("core.symlinks", "false".into()),
            ("core.autocrlf", "false".into()),
            ("core.quotePath", "false".into()),
            ("core.fsmonitor", "false".into()),
            ("protocol.version", "2".into()),
            ("http.lowSpeedLimit", "1000".into()),
            ("http.lowSpeedTime", "60".into()),
            ("submodule.recurse", "false".into()),
            ("fetch.recurseSubmodules", "false".into()),
            ("advice.detachedHead", "false".into()),
            ("gc.auto", "0".into()),
            ("maintenance.auto", "false".into()),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
        if let (Credentials::Token { username, token }, Some(origin)) =
            (session.credentials, &session.origin)
        {
            // The header is scoped to the repository's host, but Git keeps
            // sending it after a redirect to another host. So a sync that
            // carries a token never follows redirects.
            settings.push(("http.followRedirects".to_owned(), "false".into()));
            let pair = Zeroizing::new(format!("{username}:{}", token.as_str()));
            settings.push((
                format!("http.{origin}.extraHeader"),
                format!("Authorization: Basic {}", STANDARD.encode(pair.as_bytes())).into(),
            ));
        }
        command.env("GIT_CONFIG_COUNT", settings.len().to_string());
        for (index, (key, value)) in settings.into_iter().enumerate() {
            command
                .env(format!("GIT_CONFIG_KEY_{index}"), key)
                .env(format!("GIT_CONFIG_VALUE_{index}"), value);
        }
        if let Some(key) = &session.ssh_key {
            command.env("GIT_SSH_COMMAND", ssh_command(key, &self.known_hosts));
        }
        command
            .current_dir(&session.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        command
    }

    fn spawn(
        &self,
        session: &Session<'_>,
        arguments: &[&str],
        stdin: Stdio,
    ) -> Result<GitProcess, SyncError> {
        let mut command = self.command(session);
        command.args(arguments).stdin(stdin);
        #[cfg(test)]
        self.counts
            .processes
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(GitProcess {
            disk: session.disk.clone(),
            child: Some(command.spawn().map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    SyncError::new(Failure::GitUnavailable, "the git program is not installed")
                } else {
                    SyncError::new(Failure::Failed, format!("start git: {error}"))
                }
            })?),
        })
    }

    /// The selected files' contents, from one `git cat-file --batch`. No file
    /// path is resolved through the working volume.
    async fn read_blobs(
        &self,
        session: &Session<'_>,
        repository: &str,
        selected: Vec<(String, String, String)>,
        limits: Limits,
        deadline: Instant,
    ) -> Result<(Vec<SnapshotFile>, usize), SyncError> {
        let mut child = self.spawn(
            session,
            &in_repository(repository, &["cat-file", "--batch"]),
            Stdio::piped(),
        )?;
        let process = child.child.as_mut().expect("running git");
        let mut stdin = process.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(process.stdout.take().expect("piped stdout"));
        let stderr = process.stderr.take().expect("piped stderr");
        // Queue the bounded list while draining output. Waiting for a response
        // before sending each ID would add one pipe round trip per file.
        let mut requests = Vec::with_capacity(selected.len() * 65);
        for (_, _, blob) in &selected {
            requests.extend_from_slice(blob.as_bytes());
            requests.push(b'\n');
        }
        let send = async {
            stdin.write_all(&requests).await.map_err(batch_error)?;
            drop(stdin);
            Ok::<_, SyncError>(())
        };
        let run = async {
            let (files, (), stderr) =
                tokio::try_join!(read_batch(stdout, selected, limits), send, async {
                    drain_output(stderr, ERROR_OUTPUT_LIMIT)
                        .await
                        .map_err(batch_error)
                })?;
            // As in ordinary commands, drain helpers before reaping their parent.
            let status = process.wait().await.map_err(batch_error)?;
            if !status.success() {
                let stderr = String::from_utf8_lossy(&stderr);
                return Err(SyncError::new(classify(&stderr), summary(&stderr)));
            }
            Ok(files)
        };
        tokio::time::timeout_at(deadline, run)
            .await
            .map_err(|_| SyncError::new(Failure::Timeout, "git did not finish in time"))?
    }

    async fn run(
        &self,
        session: &Session<'_>,
        arguments: &[&str],
        deadline: Instant,
    ) -> Result<Vec<u8>, SyncError> {
        let output = self.output(session, arguments, deadline).await?;
        if output.success {
            Ok(output.stdout)
        } else {
            Err(SyncError::new(
                classify(&output.stderr),
                summary(&output.stderr),
            ))
        }
    }

    async fn output(
        &self,
        session: &Session<'_>,
        arguments: &[&str],
        deadline: Instant,
    ) -> Result<Output, SyncError> {
        let mut child = self.spawn(session, arguments, Stdio::null())?;
        let process = child.child.as_mut().expect("running git");
        let mut stdout = process.stdout.take().expect("piped stdout");
        let mut stderr = process.stderr.take().expect("piped stderr");
        let run = async {
            let out = drain_output(&mut stdout, OUTPUT_LIMIT + 1);
            let err = drain_output(&mut stderr, ERROR_OUTPUT_LIMIT);
            // Keep the parent's PID reserved until helpers close both pipes.
            // Cancellation can still kill its group after the parent exits.
            let (out, err) = tokio::join!(out, err);
            let (out, err) = (out?, err?);
            let status = process.wait().await?;
            Ok::<_, std::io::Error>((out, err, status))
        };
        let (stdout, stderr, status) = tokio::time::timeout_at(deadline, run)
            .await
            .map_err(|_| SyncError::new(Failure::Timeout, "git did not finish in time"))?
            .map_err(|error| {
                SyncError::new(Failure::Failed, format!("read git output: {error}"))
            })?;
        if stdout.len() as u64 > OUTPUT_LIMIT {
            return Err(SyncError::new(
                Failure::TooLarge,
                "git listed more than the limit",
            ));
        }
        Ok(Output {
            success: status.success(),
            stdout,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    /// Run `work`, stopping it once the working copy holds more than `budget`
    /// bytes. Folders of large files, and hosts that ignore partial-clone
    /// filters, would otherwise fill the data disk before the time limit.
    async fn within<T>(
        &self,
        root: &Path,
        budget: u64,
        work: impl Future<Output = Result<T, SyncError>>,
    ) -> Result<T, SyncError> {
        let watched_root = root.to_path_buf();
        let watch = async move {
            loop {
                tokio::time::sleep(WATCH_INTERVAL).await;
                let size = measure_working_copy(watched_root.clone()).await?;
                if size > budget {
                    return Ok::<_, SyncError>(size);
                }
            }
        };
        tokio::select! {
            result = work => {
                #[cfg(test)]
                self.counts.phase_walks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let size = measure_working_copy(root.to_path_buf()).await?;
                if size > budget {
                    Err(SyncError::new(Failure::TooLarge, format!("the download reached {size} bytes; the limit is {budget}")))
                } else { result }
            },
            size = watch => {
                let size = size?;
                Err(SyncError::new(Failure::TooLarge, format!("the download reached {size} bytes; the limit is {budget}")))
            },
        }
    }
}

/// Keep only a bounded prefix, but drain the pipe so helpers never block on it.
async fn drain_output(mut pipe: impl AsyncRead + Unpin, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut buffer = Vec::new();
    (&mut pipe).take(limit).read_to_end(&mut buffer).await?;
    tokio::io::copy(&mut pipe, &mut tokio::io::sink()).await?;
    Ok(buffer)
}

/// The files in a `git cat-file --batch` stream that answers `selected` in
/// order, and how many were skipped. Headers, the whole stream and the stored
/// contents are bounded, and an oversized blob is read past without being kept.
async fn read_batch(
    mut output: impl AsyncBufRead + Unpin,
    selected: Vec<(String, String, String)>,
    limits: Limits,
) -> Result<(Vec<SnapshotFile>, usize), SyncError> {
    let mut files = Vec::with_capacity(selected.len());
    let mut header = Vec::with_capacity(128);
    let mut received = 0u64;
    let mut stored = 0u64;
    let mut skipped = 0;
    for (_, path, blob) in selected {
        header.clear();
        (&mut output)
            .take(128)
            .read_until(b'\n', &mut header)
            .await
            .map_err(batch_error)?;
        let fields = std::str::from_utf8(&header)
            .ok()
            .and_then(|text| text.strip_suffix('\n'))
            .map(|line| line.split_whitespace().collect::<Vec<_>>());
        let size = match fields.as_deref() {
            Some([id, "blob", size]) if *id == blob => size.parse::<u64>().ok(),
            _ => None,
        }
        .ok_or_else(|| SyncError::new(Failure::Failed, "invalid Git batch header"))?;
        received = received.saturating_add(size);
        if received > limits.max_download_bytes {
            return Err(SyncError::new(
                Failure::TooLarge,
                "Git blob stream is larger than the download limit",
            ));
        }
        if size > limits.max_file_bytes {
            let copied = tokio::io::copy(&mut (&mut output).take(size), &mut tokio::io::sink())
                .await
                .map_err(batch_error)?;
            if copied != size {
                return Err(SyncError::new(Failure::Failed, "truncated Git blob"));
            }
            skipped += 1;
        } else {
            stored = stored.saturating_add(size);
            if stored > limits.max_total_bytes {
                return Err(SyncError::new(
                    Failure::TooLarge,
                    "the folder is larger than the limit",
                ));
            }
            let mut content = vec![0; size as usize];
            output.read_exact(&mut content).await.map_err(batch_error)?;
            files.push(SnapshotFile {
                path,
                content,
                changed_at: None,
            });
        }
        if output.read_u8().await.map_err(batch_error)? != b'\n' {
            return Err(SyncError::new(
                Failure::Failed,
                "invalid Git blob terminator",
            ));
        }
    }
    if output.read(&mut [0]).await.map_err(batch_error)? != 0 {
        return Err(SyncError::new(
            Failure::Failed,
            "unexpected Git batch output",
        ));
    }
    Ok((files, skipped))
}

fn batch_error(error: std::io::Error) -> SyncError {
    SyncError::new(Failure::Failed, format!("read git blobs: {error}"))
}

async fn measure_working_copy(root: PathBuf) -> Result<u64, SyncError> {
    tokio::task::spawn_blocking(move || tree_size(&root))
        .await
        .map_err(|error| SyncError::new(Failure::Failed, format!("measure working copy: {error}")))
}

fn tree_size(root: &Path) -> u64 {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .filter(std::fs::Metadata::is_file)
        .map(|metadata| metadata.len())
        .sum()
}

fn in_repository<'a>(repository: &'a str, arguments: &[&'a str]) -> Vec<&'a str> {
    let mut all = vec!["-C", repository];
    all.extend_from_slice(arguments);
    all
}

/// Regular files from `git ls-tree -r -z`, as repository and folder-relative
/// paths. Links, submodules and names that are not plain UTF-8 are left out.
fn select_files(
    listing: &[u8],
    folder: &str,
    max_files: usize,
) -> Result<Vec<(String, String, String)>, SyncError> {
    let prefix = if folder.is_empty() {
        String::new()
    } else {
        format!("{folder}/")
    };
    let mut files = Vec::new();
    for record in listing
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
            continue;
        };
        let meta = String::from_utf8_lossy(&record[..tab]);
        let mut fields = meta.split_whitespace();
        let (Some(mode), Some("blob")) = (fields.next(), fields.next()) else {
            continue;
        };
        if !matches!(mode, "100644" | "100755") {
            continue;
        }
        let Some(blob) = fields.next().filter(|value| is_object_id(value)) else {
            continue;
        };
        let Ok(repository_path) = std::str::from_utf8(&record[tab + 1..]) else {
            continue;
        };
        let Some(relative) = repository_path.strip_prefix(&prefix) else {
            continue;
        };
        if !valid_relative_path(relative) {
            continue;
        }
        if files.len() == max_files {
            return Err(SyncError::new(
                Failure::TooLarge,
                "the folder has more files than the limit",
            ));
        }
        files.push((
            repository_path.to_owned(),
            relative.to_owned(),
            blob.to_owned(),
        ));
    }
    Ok(files)
}

pub(crate) fn valid_relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= PATH_MAX
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.eq_ignore_ascii_case(".git")
                && !part.chars().any(|c| c.is_control() || c == '\\')
        })
}

/// When each path last changed, from `git log --format=%x1e%ct --name-only`.
/// In a shallow history the oldest commit appears to add every file, which
/// dates files older than the window to that commit.
fn change_times(log: &[u8]) -> HashMap<String, i64> {
    let mut times = HashMap::new();
    let mut current = None;
    for line in String::from_utf8_lossy(log).lines() {
        if let Some(time) = line.strip_prefix('\u{1e}') {
            current = time.trim().parse::<i64>().ok();
        } else if let Some(time) = current
            && !line.is_empty()
        {
            times.entry(line.to_owned()).or_insert(time);
        }
    }
    times
}

/// A sparse-checkout pattern that matches the folder literally.
fn escape_pattern(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len());
    for c in path.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\' | '!' | '#' | ' ') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_version(output: &str) -> Option<(u32, u32)> {
    let mut parts = output.trim().strip_prefix("git version ")?.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor: String = parts
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    Some((major, minor.parse().ok()?))
}

fn write_private(path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = crate::db::private_file_options()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(content)?;
    file.sync_all()
}

fn ssh_command(key: &Path, known_hosts: &Path) -> OsString {
    format!(
        "ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile={} -o UserKnownHostsFile={} \
         -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
         -o PasswordAuthentication=no -o ConnectTimeout=20 -o ServerAliveInterval=15 \
         -o ServerAliveCountMax=4",
        shell_quote(key),
        shell_quote(known_hosts)
    )
    .into()
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

/// Map Git's error output to a reason. Git and its transports word these
/// messages consistently under the C locale.
fn classify(stderr: &str) -> Failure {
    let text = stderr.to_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if any(&[
        "host key verification failed",
        "remote host identification has changed",
    ]) {
        Failure::HostKey
    } else if any(&["cannot run ssh", "ssh: not found", "ssh: command not found"]) {
        Failure::GitUnavailable
    } else if any(&[
        "ssl certificate problem",
        "certificate verify failed",
        "server certificate verification failed",
        "unable to get local issuer certificate",
        "self signed certificate",
        "self-signed certificate",
    ]) {
        Failure::Certificate
    } else if text.contains("the requested url returned error: 30") {
        Failure::Moved
    } else if any(&[
        "remote branch",
        "couldn't find remote ref",
        "could not find remote branch",
    ]) {
        Failure::BranchNotFound
    } else if any(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "invalid username or password",
        "http basic: access denied",
        "permission denied (publickey",
        "the requested url returned error: 401",
        "the requested url returned error: 403",
        "terminal prompts disabled",
    ]) {
        Failure::AuthFailed
    } else if any(&[
        "repository not found",
        "does not appear to be a git repository",
        "not found",
        "the requested url returned error: 404",
    ]) {
        Failure::NotFound
    } else if any(&[
        "could not resolve host",
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "no route to host",
        "failed to connect",
        "connection reset",
        "unexpected disconnect",
        "the remote end hung up",
        "transfer closed",
    ]) {
        Failure::Unreachable
    } else {
        Failure::Failed
    }
}

fn summary(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" | ");
    tail.chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;

    #[tokio::test]
    async fn reading_many_blobs_uses_bounded_processes_and_phase_walks() {
        let root = tempfile::tempdir_in("target").unwrap();
        let repository = root.path().join("source");
        std::fs::create_dir(&repository).unwrap();
        for n in 0..64 {
            let content = match n {
                17 => vec![b'x'; 33],
                18 => Vec::new(),
                19 => vec![0xff, b'\n', 0, 0xfe],
                _ => format!("Contents {n}\n").into_bytes(),
            };
            std::fs::write(repository.join(format!("{n}.md")), content).unwrap();
        }
        for args in [
            &["init", "--quiet", "--initial-branch=main"][..],
            &["add", "."],
            &["commit", "--quiet", "-m", "Files"],
        ] {
            let result = std::process::Command::new("git")
                .current_dir(&repository)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args([
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.test",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        let git = Git::new(
            root.path().join("work"),
            root.path().join("known_hosts"),
            true,
        );
        let url = GitUrl::parse(&format!("file://{}", repository.display()), true).unwrap();
        let limits = Limits {
            max_files: 5000,
            max_file_bytes: 32,
            max_total_bytes: 100 * 1024 * 1024,
            max_download_bytes: 300 * 1024 * 1024,
        };
        let reservation = crate::files::disk::DiskAdmission::new(root.path(), 0)
            .reserve(400 * 1024 * 1024)
            .unwrap();
        let snapshot = git
            .snapshot(
                &url,
                "main",
                "",
                &Credentials::None,
                SnapshotOptions {
                    limits,
                    history_depth: 1,
                },
                reservation,
            )
            .await
            .unwrap();
        assert_eq!(snapshot.files.len(), 63);
        assert_eq!(snapshot.skipped, 1);
        for file in snapshot.files {
            let expected = match file.path.as_str() {
                "17.md" => panic!("the oversized file must be skipped"),
                "18.md" => Vec::new(),
                "19.md" => vec![0xff, b'\n', 0, 0xfe],
                _ => format!("Contents {}\n", file.path.trim_end_matches(".md")).into_bytes(),
            };
            assert_eq!(file.content, expected, "{}", file.path);
        }
        let processes = git.counts.processes.load(Ordering::Relaxed);
        let phases = git.counts.phase_walks.load(Ordering::Relaxed);
        assert!(
            (1..=20).contains(&processes),
            "{processes} Git processes for 64 files"
        );
        assert!(
            (1..=4).contains(&phases),
            "{phases} full walks outside the watchdog"
        );
    }

    #[tokio::test]
    async fn batch_output_is_bounded_and_must_answer_every_request() {
        let id = |n: u8| format!("{n:040x}");
        let requests = || {
            (0..3)
                .map(|n| (format!("{n}.md"), format!("{n}.md"), id(n)))
                .collect::<Vec<_>>()
        };
        let blob = |n: u8, content: &[u8]| {
            let mut entry = format!("{} blob {}\n", id(n), content.len()).into_bytes();
            entry.extend_from_slice(content);
            entry.push(b'\n');
            entry
        };
        // A stored file, one over the per-file limit, and another stored file.
        let stream = [blob(0, b"abcd"), blob(1, b"too large"), blob(2, b"ef")].concat();
        let limits = Limits {
            max_files: 3,
            max_file_bytes: 4,
            max_total_bytes: 6,
            max_download_bytes: 15,
        };
        let (files, skipped) = read_batch(&stream[..], requests(), limits).await.unwrap();
        let read: Vec<_> = files
            .iter()
            .map(|file| (file.path.as_str(), file.content.as_slice()))
            .collect();
        assert_eq!(read, [("0.md", &b"abcd"[..]), ("2.md", &b"ef"[..])]);
        assert_eq!(skipped, 1);

        for (case, stream, limits, failure) in [
            (
                "stored files over the folder limit",
                stream.clone(),
                Limits {
                    max_total_bytes: 5,
                    ..limits
                },
                Failure::TooLarge,
            ),
            (
                "a skipped file over the download limit",
                stream.clone(),
                Limits {
                    max_download_bytes: 14,
                    ..limits
                },
                Failure::TooLarge,
            ),
            (
                "a size no download allows",
                format!("{} blob 99999999999999\n", id(0)).into_bytes(),
                limits,
                Failure::TooLarge,
            ),
            (
                "an early end",
                stream[..stream.len() - 2].to_vec(),
                limits,
                Failure::Failed,
            ),
            (
                "a missing object",
                format!("{} missing\n", id(0)).into_bytes(),
                limits,
                Failure::Failed,
            ),
            (
                "output after the last answer",
                [&stream[..], b"x"].concat(),
                limits,
                Failure::Failed,
            ),
        ] {
            let Err(error) = read_batch(&stream[..], requests(), limits).await else {
                panic!("{case} must fail");
            };
            assert_eq!(error.failure, failure, "{case}: {}", error.detail);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_after_git_exits_kills_pipe_holding_helpers_and_reaps_git() {
        let root = tempfile::tempdir_in("target").unwrap();
        let git = Git::new(
            root.path().join("work"),
            root.path().join("known_hosts"),
            false,
        );
        let url = GitUrl::parse("https://git.example.test/docs.git", false).unwrap();
        let session = git.session(&url, &Credentials::None, None).unwrap();
        let helper = session.root.join("helper");
        let parent = session.root.join("parent");
        let alias = format!(
            "alias.probe=!sleep 60 & echo $! > {}; echo $PPID > {}",
            shell_quote(&helper),
            shell_quote(&parent)
        );
        let args = ["-c", &alias, "probe"];
        let mut run =
            Box::pin(git.output(&session, &args, Instant::now() + Duration::from_secs(60)));
        async fn state(pid: u32) -> String {
            String::from_utf8(
                Command::new("ps")
                    .args(["-o", "stat=", "-p", &pid.to_string()])
                    .output()
                    .await
                    .unwrap()
                    .stdout,
            )
            .unwrap()
        }
        let ready = async {
            loop {
                if let (Ok(a), Ok(b)) = (
                    tokio::fs::read_to_string(&helper).await,
                    tokio::fs::read_to_string(&parent).await,
                ) && let (Ok(helper), Ok(parent)) =
                    (a.trim().parse::<u32>(), b.trim().parse::<u32>())
                {
                    let status = state(parent).await;
                    if status.trim().is_empty() || status.trim().starts_with('Z') {
                        break (helper, parent);
                    }
                }
                tokio::task::yield_now().await;
            }
        };
        let (helper_pid, parent_pid) = tokio::select! {
            result = &mut run => panic!("helper should keep the pipes open: {}", result.is_ok()),
            result = tokio::time::timeout(Duration::from_secs(10), ready) => result.unwrap(),
        };
        // Dropping the future must stop the group even though Git already exited.
        drop(run);
        let stopped = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let helper = state(helper_pid).await;
                if (helper.trim().is_empty() || helper.trim().starts_with('Z'))
                    && state(parent_pid).await.trim().is_empty()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        // Also clean up on the pre-fix failure.
        let _ = Command::new("kill")
            .args(["-KILL", &helper_pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .await;
        assert!(
            stopped.is_ok(),
            "the helper must stop and the Git parent must be reaped"
        );
    }

    fn listing(entries: &[(&str, &str, &str)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (mode, kind, path) in entries {
            bytes.extend_from_slice(format!("{mode} {kind} {:040x}\t{path}", 1).as_bytes());
            bytes.push(0);
        }
        bytes
    }

    #[test]
    fn regular_files_inside_the_folder_are_selected() {
        let selected = select_files(
            &listing(&[
                ("100644", "blob", "docs/README.md"),
                ("100755", "blob", "docs/tools/run.sh"),
                ("120000", "blob", "docs/link"),
                ("160000", "commit", "docs/vendor"),
                ("100644", "blob", "docs/.git/config"),
                ("100644", "blob", "other/notes.md"),
            ]),
            "docs",
            10,
        )
        .unwrap();
        assert_eq!(
            selected,
            [
                (
                    "docs/README.md".to_owned(),
                    "README.md".to_owned(),
                    format!("{:040x}", 1)
                ),
                (
                    "docs/tools/run.sh".to_owned(),
                    "tools/run.sh".to_owned(),
                    format!("{:040x}", 1)
                )
            ]
        );
    }

    #[test]
    fn folders_with_too_many_files_fail() {
        let many = listing(&[
            ("100644", "blob", "a.md"),
            ("100644", "blob", "b.md"),
            ("100644", "blob", "c.md"),
        ]);
        assert_eq!(select_files(&many, "", 3).unwrap().len(), 3);
        assert_eq!(
            select_files(&many, "", 2).err().unwrap().failure,
            Failure::TooLarge
        );
    }

    #[test]
    fn unsafe_paths_are_left_out() {
        for path in [
            "",
            "a//b",
            "../x",
            "a/./b",
            ".git/config",
            "A/.GIT/x",
            "tab\there",
            "back\\slash",
        ] {
            assert!(!valid_relative_path(path), "{path:?}");
        }
        assert!(valid_relative_path("guides/Qo‘llanma.md"));
    }

    #[test]
    fn change_times_keep_the_newest_commit_per_file() {
        let log = b"\x1e300\n\ndocs/a.md\n\x1e200\n\ndocs/a.md\ndocs/b.md\n";
        let times = change_times(log);
        assert_eq!(times["docs/a.md"], 300);
        assert_eq!(times["docs/b.md"], 200);
    }

    #[test]
    fn versions_before_2_31_are_refused() {
        assert_eq!(
            parse_version("git version 2.50.1 (Apple Git-155)\n"),
            Some((2, 50))
        );
        assert_eq!(parse_version("git version 2.39.5"), Some((2, 39)));
        assert!(parse_version("git version 2.30.2").unwrap() < MINIMUM_VERSION);
        assert_eq!(parse_version("something else"), None);
    }

    #[test]
    fn git_errors_map_to_actionable_reasons() {
        for (stderr, failure) in [
            (
                "fatal: Authentication failed for 'https://git.example.com/a.git/'",
                Failure::AuthFailed,
            ),
            (
                "git@host: Permission denied (publickey).",
                Failure::AuthFailed,
            ),
            (
                "fatal: could not read Username for 'https://host': terminal prompts disabled",
                Failure::AuthFailed,
            ),
            (
                "remote: Repository not found.\nfatal: repository 'https://h/x.git/' not found",
                Failure::NotFound,
            ),
            (
                "warning: Could not find remote branch docs to clone.\nfatal: Remote branch docs not found in upstream origin",
                Failure::BranchNotFound,
            ),
            (
                "fatal: unable to access 'https://h/': Could not resolve host: h",
                Failure::Unreachable,
            ),
            (
                "fatal: unable to access 'https://h/': SSL certificate problem: self-signed certificate",
                Failure::Certificate,
            ),
            ("Host key verification failed.", Failure::HostKey),
            (
                "fatal: unable to access 'https://h/old.git/': The requested URL returned error: 301",
                Failure::Moved,
            ),
            (
                "error: cannot run ssh: No such file or directory",
                Failure::GitUnavailable,
            ),
            ("fatal: something else", Failure::Failed),
        ] {
            assert_eq!(classify(stderr), failure, "{stderr}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn downloads_stop_once_the_working_copy_passes_the_budget() {
        let root = tempfile::tempdir_in("target").unwrap();
        let git = Git::new(
            root.path().join("work"),
            root.path().join("known_hosts"),
            false,
        );
        let write = |bytes: usize| std::fs::write(root.path().join("pack"), vec![0; bytes]);

        let small = git.within(root.path(), 100, async {
            write(100).unwrap();
            tokio::time::sleep(WATCH_INTERVAL * 4).await;
            Ok(7)
        });
        assert_eq!(small.await.unwrap(), 7);

        let large = git.within(root.path(), 100, async {
            write(101).unwrap();
            std::future::pending::<Result<(), SyncError>>().await
        });
        assert_eq!(large.await.unwrap_err().failure, Failure::TooLarge);

        let fast = git.within(root.path(), 100, async {
            write(101).unwrap();
            Ok(())
        });
        assert_eq!(fast.await.unwrap_err().failure, Failure::TooLarge);
    }

    #[test]
    fn sparse_patterns_and_shell_paths_are_escaped() {
        assert_eq!(escape_pattern("docs/a b[1]*.md"), r"docs/a\ b\[1\]\*.md");
        assert_eq!(
            shell_quote(Path::new("/data/it's here/id")),
            r"'/data/it'\''s here/id'"
        );
    }
}
