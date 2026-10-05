use std::{
    fs::{self, OpenOptions},
    path::{Component, Path, PathBuf},
};

use tokio::fs as async_fs;

use crate::{AppError, AppResult, db::DataLayout};

#[derive(Clone, Debug)]
pub struct FileStore {
    layout: DataLayout,
}

impl FileStore {
    pub fn new(layout: DataLayout) -> Self {
        Self { layout }
    }

    pub fn layout(&self) -> &DataLayout {
        &self.layout
    }

    pub fn previews(&self) -> PathBuf {
        self.layout.root().join("previews")
    }

    pub async fn ensure_directories(&self) -> AppResult<()> {
        self.reject_managed_symlinks()?;
        let layout = self.layout.clone();
        tokio::task::spawn_blocking(move || layout.ensure_runtime_directories())
            .await
            .map_err(|error| AppError::internal(format!("directory worker failed: {error}")))??;
        self.reject_managed_symlinks()?;
        Ok(())
    }

    pub fn new_storage_key(&self) -> AppResult<String> {
        let token = secure_token(24)?;
        Ok(format!("{}/{}/{}", &token[0..2], &token[2..4], token))
    }

    pub fn new_staging_key(&self) -> AppResult<String> {
        Ok(format!("{}.upload", secure_token(24)?))
    }

    pub fn staging_path(&self, key: &str) -> AppResult<PathBuf> {
        validate_leaf(key)?;
        Ok(self.layout.staging().join(key))
    }

    pub fn file_path(&self, key: &str) -> AppResult<PathBuf> {
        validate_storage_key(key)?;
        let path = self.layout.files().join(key);
        reject_symlink(&self.layout.files())?;
        if let Some(parent) = path.parent() {
            reject_symlink(parent)?;
            if let Some(shard) = parent.parent() {
                reject_symlink(shard)?;
            }
        }
        reject_symlink(&path)?;
        Ok(path)
    }

    pub async fn prepare_file_parent(&self, key: &str) -> AppResult<PathBuf> {
        let destination = self.file_path(key)?;
        let parent = destination
            .parent()
            .ok_or_else(|| AppError::internal("generated file path has no parent"))?;
        let directory = parent.to_path_buf();
        tokio::task::spawn_blocking(move || crate::db::create_private_directories(&directory))
            .await
            .map_err(|error| AppError::internal(format!("directory worker failed: {error}")))??;
        reject_symlink(parent)?;
        if let Some(grandparent) = parent.parent() {
            reject_symlink(grandparent)?;
        }
        Ok(destination)
    }

    pub async fn remove_file_if_present(&self, path: &Path) -> AppResult<()> {
        match async_fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn sync_parent(path: PathBuf) -> AppResult<()> {
        tokio::task::spawn_blocking(move || {
            let parent = path
                .parent()
                .ok_or_else(|| AppError::internal("file path has no parent"))?;
            let directory = OpenOptions::new().read(true).open(parent)?;
            directory.sync_all()?;
            Ok(())
        })
        .await
        .map_err(|error| AppError::internal(format!("directory sync worker failed: {error}")))?
    }

    pub(crate) async fn sync_deletion_parent(path: PathBuf) -> AppResult<()> {
        tokio::task::spawn_blocking(move || {
            let parent = path
                .parent()
                .ok_or_else(|| AppError::internal("file path has no parent"))?;
            match OpenOptions::new().read(true).open(parent) {
                Ok(directory) => directory.sync_all().map_err(Into::into),
                // Backups omit already-deleting bytes and may omit the shard.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            }
        })
        .await
        .map_err(|error| AppError::internal(format!("directory sync worker failed: {error}")))?
    }

    fn reject_managed_symlinks(&self) -> AppResult<()> {
        reject_symlink(self.layout.root())?;
        for directory in [self.layout.files(), self.layout.staging(), self.previews()] {
            if directory.exists() {
                reject_symlink(&directory)?;
            }
        }
        Ok(())
    }
}

pub(super) fn validate_storage_key(value: &str) -> AppResult<()> {
    let path = Path::new(value);
    if value.is_empty() || path.is_absolute() {
        return Err(AppError::internal("invalid stored file key"));
    }
    let components = path.components().collect::<Vec<_>>();
    if components.len() != 3
        || components
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::internal("invalid stored file key"));
    }
    let values = components
        .iter()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>();
    if values[0].len() != 2
        || values[1].len() != 2
        || values[2].len() != 48
        || values[2][0..2] != values[0]
        || values[2][2..4] != values[1]
        || !values[2].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::internal("invalid stored file key"));
    }
    Ok(())
}

fn validate_leaf(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(AppError::internal("invalid staging key"));
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::Io(format!(
            "managed file path may not be a symbolic link: {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn secure_token(bytes: usize) -> AppResult<String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|error| AppError::internal(format!("secure random generator failed: {error}")))?;
    Ok(hex::encode(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_storage_keys_are_sharded_and_valid() {
        let store = FileStore::new(DataLayout::new("data"));
        let key = store.new_storage_key().unwrap();
        validate_storage_key(&key).unwrap();
        assert_eq!(key.split('/').count(), 3);
    }

    #[test]
    fn path_traversal_is_never_a_storage_key() {
        for value in ["../secret", "/etc/passwd", "aa/bb/../cc", "aa\\bb\\cc"] {
            assert!(validate_storage_key(value).is_err(), "{value}");
        }
    }
}
