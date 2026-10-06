//! A stored file's bytes for a response, read from SQLite one chunk at a time
//! as the client takes them. A client that reads slowly or stops reading holds
//! about one chunk of memory, not the whole file.

use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll, ready},
};

use rusqlite::OptionalExtension;
use tokio_stream::Stream;

use crate::{AppError, AppResult, Db};

/// Bytes per database read, as attachments send them. Each read walks the
/// stored value from its start, so larger chunks would cost fewer walks, but
/// every stalled download holds a chunk in memory.
const CHUNK_BYTES: u64 = 64 * 1024;

/// The first `len()` bytes of one stored version of a Knowledge file.
pub struct FileBody {
    db: Db,
    rowid: i64,
    checksum: String,
    length: u64,
}

impl FileBody {
    pub(super) fn new(db: Db, rowid: i64, checksum: String, length: u64) -> Self {
        Self {
            db,
            rowid,
            checksum,
            length,
        }
    }

    pub fn len(&self) -> u64 {
        self.length
    }

    pub fn is_empty(&self) -> bool {
        self.length == 0
    }

    /// The bytes in chunks, each read only when the previous one was taken.
    /// If a sync replaces the file meanwhile, the stream ends with an error
    /// rather than mixing two versions.
    pub fn into_stream(self) -> Chunks {
        Chunks {
            body: self,
            offset: 0,
            pending: None,
        }
    }

    /// The first `limit` bytes at most, at once, for readers that need the
    /// start of a file in memory. Only those bytes are read.
    pub(super) async fn read_start(self, limit: u64) -> AppResult<Vec<u8>> {
        read_chunk(
            self.db,
            self.rowid,
            self.checksum,
            0,
            self.length.min(limit),
        )
        .await
    }
}

fn changed() -> AppError {
    AppError::Conflict("the file changed while it was being read".into())
}

type Read = Pin<Box<dyn Future<Output = AppResult<Vec<u8>>> + Send>>;

pub struct Chunks {
    body: FileBody,
    offset: u64,
    pending: Option<Read>,
}

impl Stream for Chunks {
    type Item = AppResult<Vec<u8>>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        if this.pending.is_none() {
            if this.offset >= this.body.length {
                return Poll::Ready(None);
            }
            let size = CHUNK_BYTES.min(this.body.length - this.offset);
            this.pending = Some(Box::pin(read_chunk(
                this.body.db.clone(),
                this.body.rowid,
                this.body.checksum.clone(),
                this.offset,
                size,
            )));
        }
        let read = ready!(
            this.pending
                .as_mut()
                .expect("pending read")
                .as_mut()
                .poll(context)
        );
        this.pending = None;
        Poll::Ready(Some(match read {
            Ok(chunk) => {
                this.offset += chunk.len() as u64;
                Ok(chunk)
            }
            Err(error) => {
                // Nothing follows an error.
                this.offset = this.body.length;
                Err(error)
            }
        }))
    }
}

async fn read_chunk(
    db: Db,
    rowid: i64,
    checksum: String,
    offset: u64,
    size: u64,
) -> AppResult<Vec<u8>> {
    db.snapshot(move |connection| {
        let current: Option<String> = connection
            .prepare_cached("SELECT checksum FROM knowledge_files WHERE rowid=?1")?
            .query_row([rowid], |row| row.get(0))
            .optional()?;
        if current != Some(checksum) {
            return Err(changed());
        }
        let blob = connection.blob_open(
            rusqlite::MAIN_DB,
            c"knowledge_files",
            c"content",
            rowid,
            true,
        )?;
        let mut chunk = vec![0; size as usize];
        blob.read_at_exact(&mut chunk, offset as usize)?;
        Ok(chunk)
    })
    .await
}
