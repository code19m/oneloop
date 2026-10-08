//! Integration tests skip SQLite's disk flushes, as SQLite's own test suite
//! does with `SQLITE_NO_SYNC`. A flush only matters when the machine loses
//! power, which no test simulates. On macOS each flush is an `F_FULLFSYNC`
//! that waits for the drive, and parallel tests queue behind each other's
//! flushes: they took about half of the suite's time.
//!
//! Everything else still goes through the default unix VFS: writes, locks,
//! shared memory and reads. A storage test checks the durability pragmas that
//! production connections set
//! (`connections_enable_durable_sync_and_collect_planner_statistics`), and
//! tests that run the `oneloop` binary flush for real.
//!
//! Tests that wait for SQLite's busy timeout on purpose run with
//! `with_instant_busy_timeout`, which skips the sleeps of that wait.

use std::{
    cell::Cell,
    ffi::c_int,
    ptr,
    sync::{
        Mutex, Once,
        atomic::{AtomicPtr, Ordering},
    },
};

use rusqlite::ffi;

static DEFAULT_VFS: AtomicPtr<ffi::sqlite3_vfs> = AtomicPtr::new(ptr::null_mut());

/// Makes this process open SQLite files through a VFS that skips `xSync`, and
/// skips sleeps on threads that `with_instant_busy_timeout` starts.
pub fn skip_disk_flushes() {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        // SAFETY: the default VFS lives for the whole process, and the leaked
        // copy registered here does too.
        unsafe {
            let default = ffi::sqlite3_vfs_find(ptr::null());
            assert!(!default.is_null(), "SQLite has a default VFS");
            DEFAULT_VFS.store(default, Ordering::Release);
            let mut vfs = *default;
            vfs.zName = c"oneloop-test-no-sync".as_ptr();
            vfs.xOpen = Some(open);
            vfs.xSleep = Some(sleep);
            let vfs = Box::leak(Box::new(vfs));
            assert_eq!(ffi::sqlite3_vfs_register(vfs, 1), ffi::SQLITE_OK);
        }
    });
}

/// Opens the file with the default VFS, then swaps in its methods without `xSync`.
unsafe extern "C" fn open(
    _vfs: *mut ffi::sqlite3_vfs,
    name: ffi::sqlite3_filename,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    let default = DEFAULT_VFS.load(Ordering::Acquire);
    // SAFETY: SQLite passes a file of the default VFS's `szOsFile`, which the
    // registered copy keeps; the default VFS gets its own pointer back.
    unsafe {
        let result = (*default).xOpen.expect("the default VFS opens files")(
            default, name, file, flags, out_flags,
        );
        // SQLite closes a file whose methods are set even when the open fails.
        let methods = (*file).pMethods;
        if !methods.is_null() {
            (*file).pMethods = without_sync(methods);
        }
        result
    }
}

/// One leaked copy of each method table the default VFS uses, with `xSync` skipped.
fn without_sync(methods: *const ffi::sqlite3_io_methods) -> *const ffi::sqlite3_io_methods {
    static COPIES: Mutex<Vec<(usize, usize)>> = Mutex::new(Vec::new());
    let mut copies = COPIES.lock().unwrap();
    if let Some(&(_, copy)) = copies
        .iter()
        .find(|(original, _)| *original == methods as usize)
    {
        return copy as *const _;
    }
    // SAFETY: the default VFS's method tables are static.
    let mut copy = unsafe { *methods };
    copy.xSync = Some(skip_sync);
    let copy: *const ffi::sqlite3_io_methods = Box::leak(Box::new(copy));
    copies.push((methods as usize, copy as usize));
    copy
}

unsafe extern "C" fn skip_sync(_file: *mut ffi::sqlite3_file, _flags: c_int) -> c_int {
    ffi::SQLITE_OK
}

thread_local! {
    static INSTANT_SLEEPS: Cell<bool> = const { Cell::new(false) };
}

/// Runs `test` as `#[tokio::test]` does, but SQLite's busy timeout runs out at
/// once on the blocking threads where `Db` runs SQLite. SQLite counts that
/// timeout in the sleeps it asks the VFS for, not on the clock, so the
/// application still sees a full five-second wait end in `SQLITE_BUSY`. This is
/// paused Tokio time for SQLite: a test that holds the write lock from another
/// connection checks what follows the timeout without waiting for it.
pub fn with_instant_busy_timeout<F: Future>(test: F) -> F::Output {
    skip_disk_flushes();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .on_thread_start(|| INSTANT_SLEEPS.set(true))
        .build()
        .unwrap()
        .block_on(test)
}

/// Sleeps with the default VFS, except on threads of `with_instant_busy_timeout`.
unsafe extern "C" fn sleep(_vfs: *mut ffi::sqlite3_vfs, microseconds: c_int) -> c_int {
    if INSTANT_SLEEPS.get() {
        return microseconds;
    }
    let default = DEFAULT_VFS.load(Ordering::Acquire);
    // SAFETY: the default VFS lives for the whole process.
    unsafe { (*default).xSleep.expect("the default VFS sleeps")(default, microseconds) }
}
