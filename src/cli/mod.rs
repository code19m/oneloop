use std::{
    io::{self, IsTerminal, Read, Write},
    path::PathBuf,
    sync::LazyLock,
};

use clap::{Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::{
    AppState, Config, Db,
    auth::{NewUser, create_user_with_policy, reset_password_with_policy, unix_now},
    config::DataConfig,
    db::{create_backup, migrate, restore_backup},
    error::{AppError, AppResult},
};

/// The version and, when known, the source revision it was built from.
static VERSION: LazyLock<String> = LazyLock::new(|| match crate::build_info::REVISION {
    "unknown" => crate::build_info::VERSION.to_owned(),
    revision => format!("{} ({revision})", crate::build_info::VERSION),
});

#[derive(Debug, Parser)]
#[command(
    name = "oneloop",
    version = VERSION.as_str(),
    about = "Self-hosted team task management",
    after_help = "Settings come from ONELOOP_* environment variables. Commands other than \
        serve read only ONELOOP_DATA_DIR (default ./data), and user also reads the \
        password settings. See https://code19m.github.io/oneloop/reference.html"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the HTTP server and MCP endpoint.
    Serve(ServeArgs),
    /// Create and recover local accounts.
    User(UserArgs),
    /// Create or restore a complete backup of the data folder.
    Backup(BackupArgs),
    /// Create or upgrade the database.
    Db(DatabaseArgs),
}

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// Validate the complete server configuration and schema, then exit.
    #[arg(long)]
    pub check: bool,
}

#[derive(Debug, Args)]
pub struct UserArgs {
    #[command(subcommand)]
    pub command: UserCommand,
}

#[derive(Debug, Subcommand)]
pub enum UserCommand {
    /// Create a local account.
    Add(UserAddArgs),
    /// Reset a local account password and revoke its credentials.
    Passwd(UserPasswordArgs),
}

#[derive(Debug, Args)]
pub struct UserAddArgs {
    /// Account name: 3 to 32 lowercase letters, digits, ".", "_" or "-",
    /// starting with a letter or digit.
    pub username: String,
    /// Grant global administrator access.
    #[arg(long)]
    pub admin: bool,
    /// Full display name. Defaults to the username.
    #[arg(long)]
    pub name: Option<String>,
    /// Read exactly one password line from standard input.
    #[arg(long)]
    pub password_stdin: bool,
}

#[derive(Debug, Args)]
pub struct UserPasswordArgs {
    /// Account name.
    pub username: String,
    /// Read exactly one password line from standard input.
    #[arg(long)]
    pub password_stdin: bool,
}

#[derive(Debug, Args)]
pub struct BackupArgs {
    #[command(subcommand)]
    pub command: BackupCommand,
}

#[derive(Debug, Subcommand)]
pub enum BackupCommand {
    /// Create and validate a complete backup of ONELOOP_DATA_DIR.
    Create {
        /// New folder for the backup. Its parent must exist, and it must be
        /// outside the data folder.
        destination: PathBuf,
    },
    /// Restore a validated backup into ONELOOP_DATA_DIR, which must be new or
    /// empty.
    Restore {
        /// Backup folder to restore from.
        backup: PathBuf,
    },
}

#[derive(Debug, Args)]
pub struct DatabaseArgs {
    #[command(subcommand)]
    pub command: DatabaseCommand,
}

#[derive(Debug, Subcommand)]
pub enum DatabaseCommand {
    /// Create the database in ONELOOP_DATA_DIR, or upgrade it to this version.
    Migrate {
        /// Folder where the backup taken before an upgrade is saved. Needed
        /// when the database is upgraded.
        #[arg(long)]
        backup_dir: Option<PathBuf>,
    },
}

pub async fn run(cli: Cli) -> AppResult<()> {
    match cli.command {
        Command::Serve(arguments) => serve(arguments).await,
        Command::User(arguments) => user(arguments).await,
        Command::Backup(arguments) => backup(arguments).await,
        Command::Db(arguments) => database(arguments).await,
    }
}

async fn serve(arguments: ServeArgs) -> AppResult<()> {
    let config = Config::from_env()?;
    if config.public_url.scheme() == "https" && config.trusted_proxies.is_empty() {
        eprintln!(
            "warning: HTTPS public URL with no trusted proxies; configure ONELOOP_TRUSTED_PROXIES to avoid shared proxy login limits"
        );
    }
    if config.mcp_client_metadata_documents {
        crate::mcp::client_metadata::check_trust_roots()?;
    }
    if arguments.check {
        crate::db::DataLayout::new(&config.data_dir).ensure_restore_complete()?;
        let database = config.data_dir.join("oneloop.sqlite3");
        if database.is_file() {
            Db::check(&config.data_dir).map_err(|error| startup_error(error, &config.data_dir))?;
            print_line(format_args!(
                "configuration and schema are valid (schema {}, data {})",
                crate::db::CURRENT_SCHEMA_VERSION,
                config.data_dir.display()
            ))?;
        } else {
            // The launchd launcher stops the job when it sees "database is not initialized".
            print_line(format_args!(
                "configuration is valid; database is not initialized (data {})",
                config.data_dir.display()
            ))?;
        }
        print_line(format_args!("SQLite {}", rusqlite::version()))?;
        print_line(format_args!(
            "IANA timezone database {}",
            config.timezone.database()
        ))?;
        return Ok(());
    }

    let db = Db::open(&config.data_dir).map_err(|error| startup_error(error, &config.data_dir))?;
    let _server_lock = db.layout().try_server_lock()?;

    init_tracing(config.log_level);
    tracing::info!(public_url = %config.public_url, trusted_proxies = ?config.trusted_proxies, "proxy configuration");
    let listen = config.listen;
    let data_dir = config.data_dir.clone();
    let timezone_database = config.timezone.database().to_string();
    let state = AppState::new(config, db);
    let application = crate::application(state);
    crate::runtime::prepare_files(&application.files)
        .await
        .map_err(|error| startup_error(error, &data_dir))?;
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|error| AppError::Unavailable(format!("cannot listen on {listen}: {error}")))?;
    let (shutdown, signal) = tokio::sync::watch::channel(false);
    let worker = application.collaboration.spawn_worker(signal.clone());
    let knowledge_worker = application.knowledge.spawn_worker(signal.clone());
    let files_worker = crate::runtime::spawn_file_maintenance(application.files, signal);
    tracing::info!(
        sqlite_version = rusqlite::version(),
        tzdb = timezone_database,
        version = crate::build_info::VERSION,
        revision = crate::build_info::REVISION,
        address = %listen,
        data_dir = %data_dir.display(),
        "oneloop listening"
    );
    let mut stopped = shutdown.subscribe();
    let server = crate::http::server::serve(listener, application.router, async move {
        while !*stopped.borrow_and_update() {
            if stopped.changed().await.is_err() {
                break;
            }
        }
    });
    tokio::pin!(server);
    let supervision = crate::runtime::supervise_workers(
        worker,
        files_worker,
        knowledge_worker,
        shutdown.clone(),
        application.collaboration,
    );
    tokio::pin!(supervision);
    let result = tokio::select! {
        result = &mut server => {
            let _ = shutdown.send(true);
            supervision.await?;
            result.map_err(AppError::from)
        }
        result = &mut supervision => {
            let _ = shutdown.send(true);
            server.await?;
            result
        }
        () = shutdown_signal() => {
            let _ = shutdown.send(true);
            let (server_result, worker_result) = tokio::join!(&mut server, &mut supervision);
            worker_result?;
            server_result.map_err(AppError::from)
        }
    };
    tracing::info!("oneloop stopped");
    result
}

async fn user(arguments: UserArgs) -> AppResult<()> {
    let config = DataConfig::from_env()?;
    let policy = crate::config::password_policy_from_env()?;
    let db = Db::open(config.data_dir)?;
    match arguments.command {
        UserCommand::Add(arguments) => {
            let password = read_password(arguments.password_stdin, true)?;
            let username = arguments.username;
            let display_name = arguments.name.unwrap_or_else(|| username.clone());
            let is_admin = arguments.admin;
            let created = db
                .transaction(move |transaction| {
                    let existing_users: i64 =
                        transaction
                            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
                    create_user_with_policy(
                        transaction,
                        NewUser {
                            username,
                            display_name,
                            password,
                            is_admin,
                            must_change_password: !(is_admin && existing_users == 0),
                        },
                        unix_now()?,
                        &policy,
                    )
                })
                .await
                .map_err(|error| match error {
                    AppError::Validation { field, message } if field == "displayName" => {
                        AppError::validation("--name", message)
                    }
                    error => error,
                })?;
            print_line(format_args!("created user {}", created.username))
        }
        UserCommand::Passwd(arguments) => {
            let password = read_password(arguments.password_stdin, true)?;
            let username = arguments.username;
            db.transaction(move |transaction| {
                reset_password_with_policy(transaction, &username, &password, unix_now()?, &policy)
            })
            .await?;
            print_line(format_args!("password reset; existing credentials revoked"))
        }
    }
}

async fn backup(arguments: BackupArgs) -> AppResult<()> {
    let config = DataConfig::from_env()?;
    match arguments.command {
        BackupCommand::Create { destination } => {
            let data_dir = config.data_dir;
            let created = tokio::task::spawn_blocking(move || create_backup(data_dir, destination))
                .await
                .map_err(|error| AppError::internal(format!("backup worker failed: {error}")))??;
            print_line(format_args!("backup created at {}", created.display()))
        }
        BackupCommand::Restore { backup } => {
            let data_dir = config.data_dir;
            let restored = tokio::task::spawn_blocking(move || restore_backup(backup, data_dir))
                .await
                .map_err(|error| AppError::internal(format!("restore worker failed: {error}")))??;
            print_line(format_args!(
                "backup restored to {}; all restored credentials were revoked",
                restored.display()
            ))
        }
    }
}

async fn database(arguments: DatabaseArgs) -> AppResult<()> {
    let config = DataConfig::from_env()?;
    match arguments.command {
        DatabaseCommand::Migrate { backup_dir } => {
            let data_dir = config.data_dir.clone();
            let outcome = tokio::task::spawn_blocking(move || migrate(data_dir, backup_dir))
                .await
                .map_err(|error| {
                    AppError::internal(format!("migration worker failed: {error}"))
                })??;
            let data_dir = config.data_dir.display();
            if outcome.applied.is_empty() {
                print_line(format_args!(
                    "database in {data_dir} is current (schema {})",
                    outcome.current_version
                ))?;
            } else if outcome.previous_version == 0 {
                print_line(format_args!(
                    "created a new database in {data_dir} (schema {})",
                    outcome.current_version
                ))?;
            } else {
                print_line(format_args!(
                    "database in {data_dir} migrated from {} to {}",
                    outcome.previous_version, outcome.current_version
                ))?;
            }
            if let Some(path) = outcome.backup_path {
                print_line(format_args!("pre-upgrade backup: {}", path.display()))?;
            }
            Ok(())
        }
    }
}

fn read_password(from_stdin: bool, confirm: bool) -> AppResult<String> {
    if from_stdin {
        let mut bytes = Vec::new();
        // Read one byte past the limit plus a possible CRLF, without buffering
        // an unbounded password from standard input.
        io::stdin()
            .take((crate::auth::password::MAX_PASSWORD_BYTES + 3) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.ends_with(b"\n") {
            bytes.pop();
            if bytes.ends_with(b"\r") {
                bytes.pop();
            }
        }
        if bytes.contains(&b'\n') || bytes.contains(&b'\r') {
            return Err(AppError::validation(
                "password",
                "standard input must contain exactly one line",
            ));
        }
        let password = String::from_utf8(bytes)
            .map_err(|_| AppError::validation("password", "password must be valid UTF-8"))?;
        crate::auth::password::validate_password_size(&password)?;
        return Ok(password);
    }
    if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
        return Err(AppError::validation(
            "password input",
            "there is no terminal to ask for the password; use --password-stdin",
        ));
    }
    let first = rpassword::prompt_password("Password: ")?;
    if confirm {
        let second = rpassword::prompt_password("Confirm password: ")?;
        if first != second {
            return Err(AppError::validation("password", "passwords do not match"));
        }
    }
    Ok(first)
}

/// Prints one line of command output. A reader that stops reading early, such
/// as `grep -q`, is not an error: the command has already done its work.
fn print_line(line: std::fmt::Arguments<'_>) -> AppResult<()> {
    match writeln!(io::stdout().lock(), "{line}") {
        Err(error) if error.kind() != io::ErrorKind::BrokenPipe => Err(error.into()),
        _ => Ok(()),
    }
}

fn init_tracing(level: tracing::Level) {
    let filter = EnvFilter::new(format!("warn,oneloop={level},rmcp=off"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none())
        .with_target(false)
        .log_internal_errors(false)
        .try_init();
}

async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {},
        () = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

fn startup_error(error: AppError, path: &std::path::Path) -> AppError {
    startup_space_hint(error, fs4::available_space(path).ok())
}

fn startup_space_hint(error: AppError, free: Option<u64>) -> AppError {
    if matches!(
        error,
        AppError::Database(_)
            | AppError::Io(_)
            | AppError::StorageFull(_)
            | AppError::PreconditionFailed(_)
    ) && let Some(free) = free.filter(|free| *free < 64 * 1024 * 1024)
    {
        return AppError::PreconditionFailed(format!(
            "{error}; the data volume has {free} bytes free; SQLite needs space for its -wal/-shm files; free disk space and retry"
        ));
    }
    error
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    #[test]
    fn disk_hint_only_enriches_failures_when_space_is_known_low() {
        assert!(
            startup_space_hint(AppError::Database("cannot open".into()), Some(0))
                .to_string()
                .contains("0 bytes free")
        );
        for free in [None, Some(100 * 1024 * 1024)] {
            assert!(matches!(
                startup_space_hint(AppError::Io("permissions".into()), free),
                AppError::Io(_)
            ));
        }
        assert!(matches!(
            startup_space_hint(AppError::Unauthorized, Some(0)),
            AppError::Unauthorized
        ));
    }
}
