//! HTTP/3 control streams parsed from captures, to see the SETTINGS and PRIORITY_UPDATE frames
//! a client sends. Values are QUIC varints of up to 62 bits, so they reach JavaScript as
//! `bigint`.

use bytes::Bytes;
use napi_derive::napi;

use crate::bridge::buffer::{ExternalBytes, JsBytes};
use crate::error::invalid_arg;

/// One frame of an HTTP/3 control stream.
#[napi(object, object_from_js = false)]
pub struct NativeH3ControlFrame {
    /// Frame type.
    pub frame_type: u64,
    /// Frame payload.
    #[napi(ts_type = "Buffer")]
    pub payload: ExternalBytes,
}

/// One HTTP/3 SETTINGS entry.
#[napi(object, object_from_js = false)]
pub struct NativeH3Setting {
    /// Setting identifier.
    pub id: u64,
    /// Setting value.
    pub value: u64,
}

/// One HTTP/3 PRIORITY_UPDATE frame.
#[napi(object, object_from_js = false)]
pub struct NativeH3PriorityUpdate {
    /// `0xf0700` for a request stream, `0xf0701` for a push.
    pub frame_type: u64,
    /// The stream or push whose priority is updated.
    pub element_id: u64,
    /// The priority field value as sent, one character per byte.
    pub field_value: String,
}

/// What a client sent on its HTTP/3 control stream.
#[napi(object, object_from_js = false)]
pub struct NativeH3ControlStream {
    /// Every frame, in order.
    pub frames: Vec<NativeH3ControlFrame>,
    /// SETTINGS entries in the order sent, unknown and repeated ids included.
    pub settings: Vec<NativeH3Setting>,
    /// PRIORITY_UPDATE frames, in order.
    pub priority_updates: Vec<NativeH3PriorityUpdate>,
}

/// Parses the start of a captured HTTP/3 control stream, decrypted and reassembled: the
/// stream type, a SETTINGS frame, then whole frames.
#[napi(catch_unwind)]
pub fn parse_h3_control_stream(
    #[napi(ts_arg_type = "Uint8Array")] data: JsBytes,
) -> napi::Result<NativeH3ControlStream> {
    let parsed = lkprofile::parse_h3_control_stream(&data.0)
        .map_err(|err| invalid_arg(format!("cannot parse the HTTP/3 control stream: {err}")))?;
    let frames = parsed
        .frames
        .iter()
        .map(|frame| NativeH3ControlFrame {
            frame_type: frame.frame_type,
            payload: ExternalBytes(Bytes::copy_from_slice(frame.payload)),
        })
        .collect();
    let settings = parsed
        .settings
        .iter()
        .map(|&(id, value)| NativeH3Setting { id, value })
        .collect();
    let priority_updates = parsed
        .priority_updates
        .iter()
        .map(|update| NativeH3PriorityUpdate {
            frame_type: update.frame_type,
            element_id: update.element_id,
            // Kept byte for byte: a capture may hold text that is not valid UTF-8.
            field_value: update.field_value.iter().copied().map(char::from).collect(),
        })
        .collect();
    Ok(NativeH3ControlStream {
        frames,
        settings,
        priority_updates,
    })
}
