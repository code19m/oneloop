use std::{
    io::{self, IsTerminal, Read},
    path::PathBuf,
};

use clap::{Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::{
    AppState, Config, Db,
    auth::{NewUser, create_user, reset_password, unix_now},
    config::DataConfig,
    db::{create_backup, migrate, restore_backup},
    error::{AppError, AppResult},
};

#[derive(Debug, Parser)]
#[command(name = "oneloop", version, about = "Self-hosted team task management")]
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
    /// Create or restore a complete backup.
    Backup(BackupArgs),
    /// Manage the database schema.
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
    /// Create and validate a complete backup directory.
    Create { destination: PathBuf },
    /// Restore a validated backup into the configured new or empty data directory.
    Restore { backup: PathBuf },
}

#[derive(Debug, Args)]
pub struct DatabaseArgs {
    #[command(subcommand)]
    pub command: DatabaseCommand,
}

#[derive(Debug, Subcommand)]
pub enum DatabaseCommand {
    /// Initialize or upgrade the database with forward-only migrations.
    Migrate {
        /// Parent directory for the mandatory validated pre-upgrade backup.
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
    if arguments.check {
        crate::db::DataLayout::new(&config.data_dir).ensure_restore_complete()?;
        let database = config.data_dir.join("oneloop.sqlite3");
        if database.is_file() {
            Db::check(&config.data_dir).map_err(|error| startup_error(error, &config.data_dir))?;
            println!(
                "configuration and schema are valid (schema {}, data {})",
                crate::db::CURRENT_SCHEMA_VERSION,
                config.data_dir.display()
            );
        } else {
            println!(
                "configuration is valid; database is not initialized (data {})",
                config.data_dir.display()
            );
        }
        println!("SQLite {}", rusqlite::version());
        println!("IANA timezone database {}", chrono_tz::IANA_TZDB_VERSION);
        return Ok(());
    }

    let db = Db::open(&config.data_dir).map_err(|error| startup_error(error, &config.data_dir))?;
    let _server_lock = db.layout().try_server_lock()?;

    init_tracing(config.log_level);
    tracing::info!(public_url = %config.public_url, trusted_proxies = ?config.trusted_proxies, "proxy configuration");
    let listen = config.listen;
    let data_dir = config.data_dir.clone();
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
        tzdb_version = chrono_tz::IANA_TZDB_VERSION,
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
                    create_user(
                        transaction,
                        NewUser {
                            username,
                            display_name,
                            password,
                            is_admin,
                            must_change_password: !(is_admin && existing_users == 0),
                        },
                        unix_now()?,
                    )
                })
                .await?;
            println!("created user {}", created.username);
            Ok(())
        }
        UserCommand::Passwd(arguments) => {
            let password = read_password(arguments.password_stdin, true)?;
            let username = arguments.username;
            db.transaction(move |transaction| {
                reset_password(transaction, &username, &password, unix_now()?)
            })
            .await?;
            println!("password reset; existing credentials revoked");
            Ok(())
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
            println!("backup created at {}", created.display());
            Ok(())
        }
        BackupCommand::Restore { backup } => {
            let data_dir = config.data_dir;
            let restored = tokio::task::spawn_blocking(move || restore_backup(backup, data_dir))
                .await
                .map_err(|error| AppError::internal(format!("restore worker failed: {error}")))??;
            println!(
                "backup restored to {}; all restored credentials were revoked",
                restored.display()
            );
            Ok(())
        }
    }
}

async fn database(arguments: DatabaseArgs) -> AppResult<()> {
    let config = DataConfig::from_env()?;
    match arguments.command {
        DatabaseCommand::Migrate { backup_dir } => {
            let outcome = tokio::task::spawn_blocking(move || migrate(config.data_dir, backup_dir))
                .await
                .map_err(|error| {
                    AppError::internal(format!("migration worker failed: {error}"))
                })??;
            if outcome.applied.is_empty() {
                println!("database schema {} is current", outcome.current_version);
            } else {
                println!(
                    "database migrated from {} to {}",
                    outcome.previous_version, outcome.current_version
                );
                if let Some(path) = outcome.backup_path {
                    println!("pre-upgrade backup: {}", path.display());
                }
            }
            Ok(())
        }
    }
}

fn read_password(from_stdin: bool, confirm: bool) -> AppResult<String> {
    if from_stdin {
        let mut bytes = Vec::new();
        io::stdin().read_to_end(&mut bytes)?;
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
        return String::from_utf8(bytes)
            .map_err(|_| AppError::validation("password", "password must be valid UTF-8"));
    }
    if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
        return Err(AppError::validation(
            "password",
            "interactive input requires a terminal; use --password-stdin for automation",
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
