//! Schema migrations, backup and restore, connection behavior and retention.

mod backup;
mod migration;
mod retention;
mod storage;

use oneloop::{
    Db,
    db::{CURRENT_SCHEMA_VERSION, migrate},
};
use tempfile::TempDir;

/// Migrates an empty data directory, checking the reported outcome.
fn initialize(root: &TempDir) -> Db {
    let outcome = migrate(root.path(), None).expect("initialize database");
    assert_eq!(outcome.previous_version, 0);
    assert_eq!(outcome.current_version, CURRENT_SCHEMA_VERSION);
    assert_eq!(
        outcome.applied,
        (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
    );
    Db::open(root.path()).expect("open current database")
}
