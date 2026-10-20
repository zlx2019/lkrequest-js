//! The session's cookie jar, behind the facade's `CookieJar`.
//!
//! Covers the cookie methods of lkrequest-py's `Session`. Setting goes through raw
//! `Set-Cookie` headers only: the facade composes them, which reaches every attribute
//! (`Expires` and `SameSite` included) while keeping upstream's parsing rules.

use lkrequest::CookieInfo;
use napi_derive::napi;

use crate::session::NativeSession;

/// A cookie as stored in the jar.
#[napi(object, object_from_js = false)]
pub struct NativeCookie {
    /// Cookie name.
    pub name: String,
    /// Cookie value.
    pub value: String,
    /// Domain the cookie is scoped to.
    pub domain: Option<String>,
    /// `true` when only the exact domain matches (the cookie had no `Domain` attribute).
    pub host_only: bool,
    /// Effective path.
    pub path: String,
    /// Sent over HTTPS only.
    pub secure: bool,
    /// Hidden from scripts.
    pub http_only: bool,
    /// `"Strict"`, `"Lax"` or `"None"`, when the cookie set one.
    pub same_site: Option<String>,
    /// Expiry as Unix seconds; absent for a session cookie.
    pub expires: Option<f64>,
}

impl From<CookieInfo> for NativeCookie {
    /// Converts upstream's cookie description.
    fn from(info: CookieInfo) -> Self {
        Self {
            name: info.name,
            value: info.value,
            domain: info.domain,
            host_only: info.host_only,
            path: info.path,
            secure: info.secure,
            http_only: info.http_only,
            same_site: info.same_site,
            expires: info.expires_unix.map(|seconds| seconds as f64),
        }
    }
}

#[napi]
impl NativeSession {
    /// Stores a cookie from a raw `Set-Cookie` header value, as if `url` had sent it.
    #[napi(catch_unwind)]
    pub fn set_cookie_raw(&self, url: String, set_cookie: String) {
        self.inner.set_cookie_raw(&url, &set_cookie);
    }

    /// Cookies that would be sent to `url`, in send order.
    #[napi]
    pub fn cookies_for(&self, url: String) -> Vec<NativeCookie> {
        self.inner
            .get_cookies_with_attrs(&url)
            .into_iter()
            .map(NativeCookie::from)
            .collect()
    }

    /// Every cookie in the jar.
    #[napi]
    pub fn all_cookies(&self) -> Vec<NativeCookie> {
        self.inner
            .get_all_cookies()
            .into_iter()
            .map(NativeCookie::from)
            .collect()
    }

    /// Values of every cookie called `name` that would be sent to `url`.
    #[napi]
    pub fn cookie_values(&self, url: String, name: String) -> Vec<String> {
        self.inner.get_cookie_values(&url, &name)
    }

    /// The `Cookie` header that would be sent to `url`, if any.
    #[napi]
    pub fn cookie_header(&self, url: String) -> Option<String> {
        self.inner.cookie_header(&url)
    }

    /// Removes the cookie called `name` that applies to `url`.
    #[napi]
    pub fn remove_cookie(&self, url: String, name: String) {
        self.inner.remove_cookie(&url, &name);
    }

    /// Empties the jar.
    #[napi]
    pub fn clear_cookies(&self) {
        self.inner.clear_cookies();
    }
}
