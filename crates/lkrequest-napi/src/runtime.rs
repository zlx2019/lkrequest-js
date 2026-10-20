//! Process-wide Tokio runtime shared by every Node.js environment that loads the addon.

use std::sync::OnceLock;

use napi::bindgen_prelude::create_custom_tokio_runtime;
use tokio::runtime::{Builder, Handle};

/// Name given to the runtime's worker threads, visible in debuggers and profilers.
const WORKER_THREAD_NAME: &str = "lkrequest-js";

/// Handle to the runtime installed at load time, for code running on the JavaScript thread.
static HANDLE: OnceLock<Handle> = OnceLock::new();

/// Installs a multi-threaded Tokio runtime when the addon is loaded, before any export runs.
///
/// The runtime must be multi-threaded: the synchronous JS callback bridge relies on
/// `tokio::task::block_in_place`, which panics on a current-thread runtime. If the runtime
/// cannot be built, napi-rs falls back to its own default multi-threaded runtime, so the
/// addon keeps working and only the thread naming is lost.
#[napi_derive::module_init]
fn init_runtime() {
    let runtime = Builder::new_multi_thread()
        .enable_all()
        .thread_name(WORKER_THREAD_NAME)
        .build();
    match runtime {
        Ok(runtime) => {
            let _ = HANDLE.set(runtime.handle().clone());
            create_custom_tokio_runtime(runtime);
        }
        Err(err) => eprintln!("lkrequest: falling back to the default Tokio runtime: {err}"),
    }
}

/// Runs `work` inside the runtime context, so upstream code that spawns tasks or looks up the
/// current runtime also works on the JavaScript thread (pool constructors, a lease released or
/// garbage collected there).
///
/// Uses a handle rather than napi-rs's `within_runtime_if_available`, which panics once the
/// runtime is gone; a finalizer can still run then, while the process exits. Spawning on a
/// runtime that has shut down drops the task instead.
pub(crate) fn enter<T>(work: impl FnOnce() -> T) -> T {
    match HANDLE.get() {
        Some(handle) => {
            let _context = handle.enter();
            work()
        }
        None => work(),
    }
}
