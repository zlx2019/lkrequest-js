//! `FormData` entries to upstream's `Multipart`.
//!
//! Upstream encodes the form with a Chrome-style `----WebKitFormBoundary…` boundary. Node's
//! own encoder (`new Response(formData)`) would use undici's boundary format instead, which is
//! a recognizable fingerprint, so the facade hands over the entries rather than encoded bytes.

use lkrequest::multipart::{Multipart, Part};
use napi_derive::napi;

use crate::bridge::buffer::JsBytes;
use crate::error::invalid_arg;

/// One `FormData` entry; exactly one of `text` and `data` is set.
#[napi(object, object_to_js = false)]
pub struct NativePart {
    /// Field name.
    pub name: String,
    /// Value of a text field.
    pub text: Option<String>,
    /// Content of a file field.
    #[napi(ts_type = "Uint8Array")]
    pub data: Option<JsBytes>,
    /// File name of a file field.
    pub filename: Option<String>,
    /// Media type of a file field.
    pub content_type: Option<String>,
}

/// Builds an upstream form from the entries, in order.
pub(crate) fn to_multipart(parts: Vec<NativePart>) -> napi::Result<Multipart> {
    parts.into_iter().try_fold(Multipart::new(), |form, part| {
        match (part.text, part.data) {
            (Some(text), None) => Ok(form.text(&part.name, &text)),
            (None, Some(data)) => {
                let mut file = Part::new(&part.name, data.0);
                if let Some(filename) = &part.filename {
                    file = file.filename(filename);
                }
                if let Some(content_type) = &part.content_type {
                    file = file.content_type(content_type);
                }
                Ok(form.part(file))
            }
            _ => Err(invalid_arg(format!(
                "form field {:?} must have exactly one of text and data",
                part.name
            ))),
        }
    })
}
