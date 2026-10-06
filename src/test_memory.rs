//! Heap use measured per thread, for unit tests that bound the memory a
//! function needs. The counts include only allocations made on the calling
//! thread, so tests that run at the same time don't disturb each other.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};

struct Counting;

#[global_allocator]
static ALLOCATOR: Counting = Counting;

thread_local! {
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

fn grow(size: usize) {
    let _ = LIVE.try_with(|live| {
        let now = live.get().saturating_add(size);
        live.set(now);
        let _ = PEAK.try_with(|peak| peak.set(peak.get().max(now)));
    });
}

fn shrink(size: usize) {
    let _ = LIVE.try_with(|live| live.set(live.get().saturating_sub(size)));
}

// SAFETY: every call goes to the system allocator unchanged; only counts are
// added, and counting never allocates.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            grow(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            grow(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        shrink(layout.size());
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, size) };
        if !moved.is_null() {
            // A move holds both blocks for a moment.
            grow(size);
            shrink(layout.size());
        }
        moved
    }
}

/// Watches the heap this thread uses from now on.
pub(crate) struct Watch {
    before: usize,
}

impl Watch {
    pub(crate) fn start() -> Self {
        let before = LIVE.with(Cell::get);
        PEAK.with(|peak| peak.set(before));
        Self { before }
    }

    /// The most heap memory the thread held at once since the start, beyond
    /// what it held before.
    pub(crate) fn peak(&self) -> usize {
        PEAK.with(Cell::get) - self.before
    }
}

/// Runs `work` and returns its result with the most heap memory it held at
/// once, beyond what the thread held before.
pub(crate) fn peak_heap<T>(work: impl FnOnce() -> T) -> (T, usize) {
    let watch = Watch::start();
    let result = work();
    (result, watch.peak())
}

/// The heap memory this thread holds now.
pub(crate) fn live_heap() -> usize {
    LIVE.with(Cell::get)
}
