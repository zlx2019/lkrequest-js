//! Node-API bindings for the `lkrequest` HTTP client.
//!
//! This crate is the private native layer of the `lkrequest` npm package: it exposes the
//! upstream Rust capabilities to the TypeScript facade in the repository's `src/` directory,
//! which defines the public JavaScript API. Every `#[napi]` export here is an implementation
//! detail of that facade and is not documented for end users.

// napi-derive registers `#[napi]` exports only outside `cfg(test)` (a test binary has no
// Node.js runtime), so in the test harness every export looks unused. Regular builds still
// report genuinely dead code.
#![cfg_attr(test, allow(dead_code))]

mod bridge;
mod build_info;
mod client;
mod cookie;
mod dns;
mod error;
mod fingerprint;
mod hsts;
mod keylog;
mod logging;
mod masque;
mod metrics;
mod multipart;
mod network_partition;
mod preset;
mod protocol;
mod proxy;
mod proxy_source;
mod quic;
mod randomize;
mod request;
mod resolver;
mod response;
mod retry;
mod runtime;
mod session;
mod session_pool;
mod streaming;
mod testing;
mod types;
mod websocket;
