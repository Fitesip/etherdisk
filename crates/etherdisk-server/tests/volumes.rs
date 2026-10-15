//! Storage spread over several directories (volumes).

use bytes::Bytes;
use etherdisk_server::connect_db;
use etherdisk_server::storage::BlobStore;
use etherdisk_server::volumes::VolumeStore;
use futures_util::TryStreamExt;

async fn read(store: &VolumeStore, key: &str) -> Vec<u8> {
    let chunks: Vec<Bytes> = store.read_range(key, 0, 1 << 20).await.unwrap().try_collect().await.unwrap();
    chunks.concat()
}

#[tokio::test]
async fn vaults_spread_over_volumes_and_stay_put() {
    let tmp = tempfile::tempdir().unwrap();
    let db = connect_db(&format!("sqlite://{}", tmp.path().join("t.db").display())).await.unwrap();
    let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));

    let store = VolumeStore::open(&[a.clone(), b.clone()], db.clone()).await.unwrap();
    // Same filesystem: free space differs only by what else is written meanwhile (under
    // FREE_SPACE_TIE), so the volume with fewer vaults takes the next one.
    store.put("1/x", Bytes::from_static(b"one")).await.unwrap();
    store.put("2/x", Bytes::from_static(b"two")).await.unwrap();
    store.put("1/y", Bytes::from_static(b"one-more")).await.unwrap();
    assert!(a.join("1/x").exists() && a.join("1/y").exists(), "a vault stays on one volume");
    assert!(b.join("2/x").exists());
    let info = store.info().await.unwrap();
    assert_eq!(info.iter().map(|v| v.vaults).collect::<Vec<_>>(), vec![1, 1]);
    assert!(info[0].total_bytes >= info[0].available_bytes && info[0].available_bytes > 0);
    assert_eq!(store.size("3/x").await.unwrap(), None, "unplaced vault has nothing");
    drop(store);

    // Restart with the directories listed the other way round: everything is still found.
    let store = VolumeStore::open(&[b.clone(), a.clone()], db.clone()).await.unwrap();
    assert_eq!(read(&store, "1/y").await, b"one-more");
    assert_eq!(read(&store, "2/x").await, b"two");
    drop(store);

    // A volume left out of the config: its vaults fail instead of starting over elsewhere.
    let store = VolumeStore::open(std::slice::from_ref(&a), db.clone()).await.unwrap();
    assert!(store.put("2/z", Bytes::from_static(b"!")).await.is_err());
    assert!(store.size("2/x").await.is_err());
    assert_eq!(read(&store, "1/x").await, b"one");

    // Formatting frees the place.
    store.delete_vault("1").await.unwrap();
    assert!(!a.join("1").exists());
    assert_eq!(store.size("1/x").await.unwrap(), None);
}

#[tokio::test]
async fn existing_data_is_adopted_and_duplicates_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let db = connect_db(&format!("sqlite://{}", tmp.path().join("t.db").display())).await.unwrap();
    // A data directory from before volumes: vault folders, no marker.
    let old = tmp.path().join("blobs");
    std::fs::create_dir_all(old.join("7")).unwrap();
    std::fs::write(old.join("7/file"), b"legacy").unwrap();
    let new = tmp.path().join("raid2");

    let store = VolumeStore::open(&[old.clone(), new.clone()], db.clone()).await.unwrap();
    assert_eq!(read(&store, "7/file").await, b"legacy");
    assert!(old.join(".etherdisk-volume").exists() && new.join(".etherdisk-volume").exists());
    drop(store);

    // The same directory twice is a config mistake.
    assert!(VolumeStore::open(&[old.clone(), old], db).await.is_err());
}

#[tokio::test]
async fn a_drive_keeps_its_unused_capacity_reserved_on_disk() {
    const MB: u64 = 1 << 20;
    let tmp = tempfile::tempdir().unwrap();
    let db = connect_db(&format!("sqlite://{}", tmp.path().join("t.db").display())).await.unwrap();
    let dir = tmp.path().join("v");
    // Kept free 0: the test may run on a nearly full disk.
    let store = VolumeStore::open(std::slice::from_ref(&dir), db.clone()).await.unwrap().keep_free(0);
    let reserve = |token: &str| std::fs::metadata(dir.join(token).join(".reserve")).map(|m| m.len()).unwrap_or(0);

    // A new drive takes its whole capacity; uploads shrink it, deletions grow it back.
    assert_eq!(store.reserve("1", 64 * MB, 0).await.unwrap(), 0);
    assert_eq!(reserve("1"), 64 * MB);
    assert_eq!(store.info().await.unwrap()[0].reserved_bytes, 64 * MB);
    assert_eq!(store.reserve("1", 64 * MB, 48 * MB).await.unwrap(), 0);
    assert_eq!(reserve("1"), 16 * MB);
    store.put("1/x", Bytes::from_static(b"data")).await.unwrap();
    assert_eq!(read(&store, "1/x").await, b"data", "the reservation sits next to the drive's files");
    assert_eq!(store.reserve("1", 64 * MB, 0).await.unwrap(), 0);
    assert_eq!(reserve("1"), 64 * MB);
    assert!(store.shortages().is_empty());
    assert_eq!(store.shortage("1"), 0);

    // What doesn't fit is reported, not forced: here the whole volume is kept free, so a new
    // drive gets nothing (it can store 0 bytes until storage is added).
    let full = VolumeStore::open(std::slice::from_ref(&dir), db.clone()).await.unwrap().keep_free(100);
    assert_eq!(full.reserve("2", 8 * MB, 0).await.unwrap(), 8 * MB);
    assert_eq!(full.shortages(), [("2".to_owned(), 8 * MB)]);
    assert_eq!(full.shortage("2"), 8 * MB);
    assert_eq!(reserve("2"), 0);
    // A drive that got only part of its capacity (16 of 64 MB here) keeps that part: its
    // uploads come out of its own reservation, never out of the volume's kept-free space.
    std::fs::create_dir_all(dir.join("4")).unwrap();
    std::fs::File::create(dir.join("4/.reserve")).unwrap().set_len(16 * MB).unwrap();
    assert_eq!(full.reserve("4", 64 * MB, 0).await.unwrap(), 48 * MB);
    assert_eq!(full.reserve("4", 64 * MB, 4 * MB).await.unwrap(), 48 * MB, "still 16 MB backed");
    assert_eq!(reserve("4"), 12 * MB, "the 4 MB upload took its room from the drive's reservation");
    // Shrinking always works, and a format frees the place and the shortage.
    assert_eq!(full.reserve("1", 64 * MB, 63 * MB).await.unwrap(), 0);
    assert_eq!(reserve("1"), MB);
    full.delete_vault("2").await.unwrap();
    assert_eq!(full.shortages(), [("4".to_owned(), 48 * MB)], "only the drive that is still short");
    full.delete_vault("4").await.unwrap();
    assert!(full.shortages().is_empty());
}
