//! Blob storage for ciphertext. Local disk now; the trait is the seam for S3 later.
//!
//! Keys look like `{token_id}/{object_id}` and `{token_id}/{object_id}.thumb`.

use std::io;
use std::path::PathBuf;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub type ByteStream = BoxStream<'static, io::Result<Bytes>>;

#[derive(Debug, thiserror::Error)]
pub enum AppendError {
    #[error("body exceeds the declared size")]
    TooLarge,
    #[error(transparent)]
    Io(#[from] io::Error),
}

#[async_trait]
pub trait BlobStore: Send + Sync {
    /// Current size, `None` if the blob does not exist.
    async fn size(&self, key: &str) -> io::Result<Option<u64>>;
    /// Appends the whole stream or nothing: on error (or more than `max` bytes)
    /// the blob is rolled back to its previous size. Returns the new size.
    async fn append(&self, key: &str, body: ByteStream, max: u64) -> Result<u64, AppendError>;
    async fn put(&self, key: &str, data: Bytes) -> io::Result<()>;
    async fn read_range(&self, key: &str, offset: u64, len: u64) -> io::Result<ByteStream>;
    /// Missing blobs are not an error.
    async fn delete(&self, key: &str) -> io::Result<()>;
    /// Deletes every blob of a vault.
    async fn delete_vault(&self, token_id: &str) -> io::Result<()>;
    /// Keeps `bytes` of disk space allocated for the vault (its capacity minus what it
    /// stores), placing a new vault where `capacity` fits. Returns how many of those bytes
    /// could not be reserved (0 when all are). Stores without reservations do nothing.
    async fn reserve(&self, _token_id: &str, _capacity: u64, _bytes: u64) -> io::Result<u64> {
        Ok(0)
    }
}

pub fn content_key(token_id: &str, object_id: &uuid::Uuid) -> String {
    format!("{token_id}/{object_id}")
}

pub fn thumb_key(token_id: &str, object_id: &uuid::Uuid) -> String {
    format!("{token_id}/{object_id}.thumb")
}

pub struct LocalStore {
    root: PathBuf,
}

impl LocalStore {
    pub fn new(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    // Keys are built only from a decimal token id and a parsed UUID, so they are safe path segments.
    fn path(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }
}

fn ignore_missing(r: io::Result<()>) -> io::Result<()> {
    match r {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

#[async_trait]
impl BlobStore for LocalStore {
    async fn size(&self, key: &str) -> io::Result<Option<u64>> {
        match tokio::fs::metadata(self.path(key)).await {
            Ok(m) => Ok(Some(m.len())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn append(&self, key: &str, mut body: ByteStream, max: u64) -> Result<u64, AppendError> {
        let path = self.path(key);
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        // Not opened in append mode: rolling back needs set_len, which requires write access.
        let mut file = tokio::fs::OpenOptions::new().create(true).write(true).truncate(false).open(&path).await?;
        let start = file.seek(io::SeekFrom::End(0)).await?;

        let mut written = 0u64;
        let result: Result<(), AppendError> = async {
            while let Some(frame) = body.next().await {
                let frame = frame?;
                written += frame.len() as u64;
                if written > max {
                    return Err(AppendError::TooLarge);
                }
                file.write_all(&frame).await?;
            }
            file.flush().await?;
            Ok(())
        }
        .await;

        if let Err(e) = result {
            file.set_len(start).await?;
            return Err(e);
        }
        file.sync_data().await?;
        Ok(start + written)
    }

    async fn put(&self, key: &str, data: Bytes) -> io::Result<()> {
        let path = self.path(key);
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        tokio::fs::write(path, data).await
    }

    async fn read_range(&self, key: &str, offset: u64, len: u64) -> io::Result<ByteStream> {
        let mut file = tokio::fs::File::open(self.path(key)).await?;
        file.seek(io::SeekFrom::Start(offset)).await?;
        Ok(tokio_util::io::ReaderStream::new(file.take(len)).boxed())
    }

    async fn delete(&self, key: &str) -> io::Result<()> {
        ignore_missing(tokio::fs::remove_file(self.path(key)).await)
    }

    async fn delete_vault(&self, token_id: &str) -> io::Result<()> {
        ignore_missing(tokio::fs::remove_dir_all(self.path(token_id)).await)
    }
}

/// Reads a whole (small) range into memory.
pub async fn read_to_vec(store: &dyn BlobStore, key: &str, offset: u64, len: u64) -> io::Result<Vec<u8>> {
    let chunks: Vec<Bytes> = store.read_range(key, offset, len).await?.try_collect().await?;
    Ok(chunks.concat())
}
