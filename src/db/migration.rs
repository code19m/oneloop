use crate::clock::unix_now as unix_timestamp;
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

use crate::{
    db::{DataLayout, integrity_check, open_connection},
    error::{AppError, AppResult},
};

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
    hook_revision: &'static str,
    hook: Option<fn(&Transaction<'_>) -> AppResult<()>>,
    foreign_keys_off: bool,
}

#[path = "legacy/mod.rs"]
mod legacy;

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial",
        sql: include_str!("../../migrations/0001_initial.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 2,
        name: "knowledge",
        sql: include_str!("../../migrations/0002_knowledge.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 3,
        name: "file_deletion_provenance",
        sql: include_str!("../../migrations/0003_file_deletion_provenance.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
];

pub const CURRENT_SCHEMA_VERSION: i64 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigrationOutcome {
    pub previous_version: i64,
    pub current_version: i64,
    pub applied: Vec<i64>,
    pub backup_path: Option<PathBuf>,
}

pub fn migrate(
    data_dir: impl Into<PathBuf>,
    backup_dir: Option<PathBuf>,
) -> AppResult<MigrationOutcome> {
    let layout = DataLayout::new(data_dir);
    super::create_private_directories(layout.root())?;
    // Check after creation: creating directories can change where the path leads.
    layout.ensure_restore_complete()?;
    let _instance_lock = layout.try_instance_exclusive_lock()?;
    let _lock = layout.open_exclusive_lock()?;
    let existed = layout.database().is_file();
    super::create_database_file(&layout.database())?;
    let mut connection = open_connection(&layout.database())?;
    let previous_version = inspect_schema_version(&connection)?;

    let legacy = is_legacy_schema(&connection)?;
    if !legacy && previous_version > CURRENT_SCHEMA_VERSION {
        return Err(AppError::PreconditionFailed(format!(
            "database schema {previous_version} is newer than this binary supports ({CURRENT_SCHEMA_VERSION})"
        )));
    }
    if !legacy {
        verify_applied_checksums(&connection)?;
    }
    if !legacy && previous_version == CURRENT_SCHEMA_VERSION {
        integrity_check(&connection)?;
        layout.ensure_runtime_directories()?;
        return Ok(MigrationOutcome {
            previous_version,
            current_version: previous_version,
            applied: Vec::new(),
            backup_path: None,
        });
    }

    let backup_path = if existed && previous_version > 0 {
        let directory = backup_dir.ok_or_else(|| {
            AppError::PreconditionFailed(
                "--backup-dir is required before upgrading an existing database".to_owned(),
            )
        })?;
        Some(super::backup::create_backup_while_locked(
            &layout,
            &directory.join(format!(
                "oneloop-pre-migration-v{previous_version}-{}",
                unix_timestamp()?
            )),
            &connection,
        )?)
    } else {
        None
    };

    if let Some(path) = &backup_path {
        eprintln!("pre-upgrade backup: {}", path.display());
    }
    let mut current_version = previous_version;
    let mut current_step = "migration setup".to_owned();
    let result = (|| {
        ensure_migration_table(&connection)?;
        let mut applied = Vec::new();
        if legacy {
            current_step = "legacy baseline conversion".to_owned();
            convert_legacy(&mut connection, previous_version)?;
            applied.push(1);
            current_version = 1;
        }
        let starting_version = current_version;
        for migration in MIGRATIONS
            .iter()
            .filter(|migration| migration.version > starting_version)
        {
            current_step = format!("migration {} ({})", migration.version, migration.name);
            apply_migration(&mut connection, migration)?;
            current_version = migration.version;
            applied.push(migration.version);
        }

        current_step = "post-migration validation".to_owned();
        ensure_current_schema(&connection)?;
        integrity_check(&connection)?;
        layout.ensure_runtime_directories()?;
        Ok(MigrationOutcome {
            previous_version,
            current_version: CURRENT_SCHEMA_VERSION,
            applied,
            backup_path: backup_path.clone(),
        })
    })();
    result.map_err(|error: AppError| AppError::PreconditionFailed(format!(
        "{current_step} failed; database left at schema {current_version}; pre-upgrade backup: {}: {error}",
        backup_path.as_ref().map(|path| path.display().to_string()).unwrap_or_else(|| "none (fresh database)".to_owned())
    )))
}

fn apply_migration(connection: &mut Connection, migration: &Migration) -> AppResult<()> {
    if migration.foreign_keys_off {
        // SQLite ignores this pragma after BEGIN. Rebuilds must opt in here.
        connection.pragma_update(None, "foreign_keys", "OFF")?;
    }
    let result: AppResult<()> = (|| {
        let transaction = connection.transaction()?;
        let enabled: bool =
            transaction.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        if enabled == migration.foreign_keys_off {
            return Err(AppError::Database(
                "unexpected migration foreign-key enforcement mode".to_owned(),
            ));
        }
        transaction.execute_batch(migration.sql)?;
        if let Some(hook) = migration.hook {
            hook(&transaction)?;
        }
        // Validate before committing even when enforcement was disabled.
        let violations: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
            [],
            |row| row.get(0),
        )?;
        if violations {
            return Err(AppError::Database(
                "migration foreign-key check failed; rolled back".to_owned(),
            ));
        }
        transaction.execute(
            "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            params![migration.version, migration.name, checksum(migration), unix_timestamp()?],
        )?;
        transaction.pragma_update(None, "user_version", migration.version)?;
        transaction.commit()?;
        Ok(())
    })();
    // The transaction has committed or rolled back before enforcement is restored.
    let restore = connection.pragma_update(None, "foreign_keys", "ON");
    result?;
    restore?;
    Ok(())
}

pub(crate) fn ensure_current_schema(connection: &Connection) -> AppResult<()> {
    let version = inspect_schema_version(connection)?;
    if is_legacy_schema(connection)? {
        return Err(AppError::PreconditionFailed("legacy pre-release database requires the baseline conversion; run `oneloop db migrate --backup-dir <directory>`".to_owned()));
    }
    if version < CURRENT_SCHEMA_VERSION {
        return Err(AppError::PreconditionFailed(format!(
            "database schema {version} requires migration to {CURRENT_SCHEMA_VERSION}; run `oneloop db migrate`"
        )));
    }
    if version > CURRENT_SCHEMA_VERSION {
        return Err(AppError::PreconditionFailed(format!(
            "database schema {version} is newer than this binary supports ({CURRENT_SCHEMA_VERSION})"
        )));
    }
    verify_applied_checksums(connection)
}

pub(crate) fn ensure_supported_schema(connection: &Connection) -> AppResult<i64> {
    let version = inspect_schema_version(connection)?;
    if is_legacy_schema(connection)? {
        return Ok(version);
    }
    if version <= 0 || version > CURRENT_SCHEMA_VERSION {
        return Err(AppError::PreconditionFailed(format!(
            "database schema {version} is not supported by this binary"
        )));
    }
    verify_applied_checksums(connection)?;
    Ok(version)
}

pub(crate) fn inspect_schema_version(connection: &Connection) -> AppResult<i64> {
    let migration_table_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |row| row.get(0),
    )?;
    if !migration_table_exists {
        let application_table: Option<String> = connection
            .query_row(
                "SELECT name FROM sqlite_schema
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(table) = application_table {
            return Err(AppError::PreconditionFailed(format!(
                "database has an unrecognized schema (found table {table})"
            )));
        }
        return Ok(0);
    }
    let recorded: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    let pragma: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if pragma != recorded {
        return Err(AppError::PreconditionFailed(format!(
            "schema version metadata disagrees (user_version={pragma}, migrations={recorded})"
        )));
    }
    Ok(recorded)
}

fn ensure_migration_table(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            checksum TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        ) STRICT;",
    )?;
    Ok(())
}

fn verify_applied_checksums(connection: &Connection) -> AppResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(());
    }
    let version = inspect_schema_version(connection)?;
    let count: i64 =
        connection.query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0))?;
    if count != version || version > CURRENT_SCHEMA_VERSION {
        return Err(AppError::PreconditionFailed(
            "unrecognized migration chain".to_owned(),
        ));
    }
    for migration in MIGRATIONS.iter().filter(|m| m.version <= version) {
        let applied: Option<(String, String)> = connection
            .query_row(
                "SELECT name,checksum FROM schema_migrations WHERE version=?1",
                [migration.version],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if applied != Some((migration.name.to_owned(), checksum(migration))) {
            return Err(AppError::PreconditionFailed(format!(
                "migration {} has changed after it was applied",
                migration.version
            )));
        }
    }
    Ok(())
}

// Recognition is exact, contiguous, and bounded. A version number alone never
// authorizes legacy conversion or backup restore.
fn is_legacy_schema(connection: &Connection) -> AppResult<bool> {
    let version = inspect_schema_version(connection)?;
    if !(1..=legacy::MIGRATIONS.len() as i64).contains(&version) {
        return Ok(false);
    }
    let count: i64 =
        connection.query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0))?;
    if count != version {
        return Ok(false);
    }
    for migration in legacy::MIGRATIONS.iter().take(version as usize) {
        let row: Option<(String, String)> = connection
            .query_row(
                "SELECT name,checksum FROM schema_migrations WHERE version=?1",
                [migration.version],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if row != Some((migration.name.to_owned(), checksum(migration))) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn convert_legacy(connection: &mut Connection, previous: i64) -> AppResult<()> {
    connection.pragma_update(None, "foreign_keys", "OFF")?;
    let result: AppResult<()> = (|| {
        let tx = connection.transaction()?;
        for migration in legacy::MIGRATIONS.iter().filter(|m| m.version > previous) {
            tx.execute_batch(migration.sql).map_err(|error| {
                AppError::Database(format!(
                    "migration {} ({}) failed: {error}",
                    migration.version, migration.name
                ))
            })?;
            if let Some(hook) = migration.hook {
                hook(&tx)?;
            }
        }
        tx.execute_batch(include_str!("legacy/planning.sql"))?;
        integrity_check(&tx)?;
        tx.execute("DELETE FROM schema_migrations", [])?;
        tx.execute(
            "INSERT INTO schema_migrations VALUES(1,'initial',?1,?2)",
            params![checksum(&MIGRATIONS[0]), unix_timestamp()?],
        )?;
        tx.pragma_update(None, "user_version", MIGRATIONS[0].version)?;
        tx.commit()?;
        Ok(())
    })();
    let restore = connection.pragma_update(None, "foreign_keys", "ON");
    result?;
    restore?;
    Ok(())
}

fn checksum(migration: &Migration) -> String {
    let mut digest = Sha256::new();
    digest.update(migration.sql.as_bytes());
    // Only the frozen legacy descriptors retain SQL-only hook checksums.
    // Every new hook requires a revision, regardless of the baseline numbering.
    if migration.hook.is_some()
        && !legacy::MIGRATIONS
            .iter()
            .any(|old| std::ptr::eq(old, migration))
    {
        assert!(
            !migration.hook_revision.is_empty(),
            "migration hook requires a revision"
        );
        digest.update(b"\0hook_revision\0");
        digest.update(migration.hook_revision.as_bytes());
    }
    hex::encode(digest.finalize())
}

#[cfg(test)]
mod tests;
