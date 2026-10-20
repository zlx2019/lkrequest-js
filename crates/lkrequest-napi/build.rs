//! Build script: configures linking against the Node-API symbols of the host runtime.

/// Emits the platform-specific linker settings napi-rs needs for a Node.js addon.
fn main() {
    napi_build::setup();
}
