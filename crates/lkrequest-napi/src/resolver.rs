//! A JavaScript DNS resolver behind upstream's `DnsResolver` trait.
//!
//! Upstream resolves names in async code, so the callbacks are awaited with the async bridge
//! and no thread blocks while JavaScript runs. Upstream bounds every lookup with the client's
//! DNS timeout (`timeouts.dns`, 5 seconds by default, which the facade cannot turn off), so a
//! call still queued when its environment shuts down, and never answered, ends there too.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use async_trait::async_trait;
use lkrequest::dns::{DnsResolver, HttpsRecord};
use napi::bindgen_prelude::FnArgs;
use napi_derive::napi;

use crate::bridge::buffer::JsBytes;
use crate::bridge::callback::{CallbackError, JsFn, call};

/// A JavaScript `resolve(host, port)`, resolving with the addresses to try, in order. Weak, so
/// a client's resolver never keeps the process alive.
pub(crate) type ResolveFn = JsFn<FnArgs<(String, u32)>, Vec<String>, true>;

/// A JavaScript `lookupHttps(host)`, resolving with an HTTPS record or `null`.
pub(crate) type LookupHttpsFn = JsFn<String, Option<NativeHttpsRecord>, true>;

/// An HTTPS (SVCB) record as a JavaScript resolver describes it.
#[napi(object, object_to_js = false)]
pub struct NativeHttpsRecord {
    /// Application protocols the endpoint speaks, such as `h3`.
    pub alpn: Option<Vec<String>>,
    /// The protocol implied by the URL scheme is not available at this endpoint.
    pub no_default_alpn: Option<bool>,
    /// Name to connect to instead of the host.
    pub target: Option<String>,
    /// Port to connect to instead of the URL's.
    pub port: Option<u32>,
    /// Encrypted Client Hello configuration list.
    #[napi(ts_type = "Uint8Array")]
    pub ech: Option<JsBytes>,
    /// IPv4 addresses the endpoint is reachable at.
    pub ipv4_hints: Option<Vec<String>>,
    /// IPv6 addresses the endpoint is reachable at.
    pub ipv6_hints: Option<Vec<String>>,
}

/// Upstream's resolver trait backed by JavaScript functions.
pub(crate) struct JsResolver {
    resolve: ResolveFn,
    lookup_https: Option<LookupHttpsFn>,
}

impl JsResolver {
    /// A resolver calling `resolve`, and `lookup_https` when it is given.
    pub(crate) fn new(resolve: ResolveFn, lookup_https: Option<LookupHttpsFn>) -> Self {
        Self {
            resolve,
            lookup_https,
        }
    }
}

#[async_trait]
impl DnsResolver for JsResolver {
    /// Asks the JavaScript function. A failure or an address that cannot be parsed fails the
    /// lookup, which upstream reports as a connection error; upstream's DNS timeout ends a
    /// late answer.
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        let args = FnArgs::from((host.to_owned(), u32::from(port)));
        let answers = call(&self.resolve, args, None)
            .await
            .map_err(|err| failed("resolve", host, &err))?;
        answers
            .iter()
            .map(|answer| parse_address(answer, port))
            .collect::<Result<_, _>>()
            .map_err(|err| {
                tracing::warn!(
                    target: "lkrequest_napi::bridge",
                    host,
                    error = %err,
                    "dns resolver returned an invalid address"
                );
                err
            })
    }

    /// Asks the JavaScript function for an HTTPS record; without one there is none. A failure
    /// is an error, which upstream treats as "no record".
    async fn lookup_https(&self, host: &str) -> io::Result<Option<HttpsRecord>> {
        let Some(lookup) = &self.lookup_https else {
            return Ok(None);
        };
        let record = call(lookup, host.to_owned(), None)
            .await
            .map_err(|err| failed("lookupHttps", host, &err))?;
        record
            .map(NativeHttpsRecord::into_upstream)
            .transpose()
            .map_err(|message| {
                tracing::warn!(
                    target: "lkrequest_napi::bridge",
                    host,
                    error = %message,
                    "dns lookupHttps returned an invalid record"
                );
                io::Error::new(io::ErrorKind::InvalidData, message)
            })
    }
}

/// Logs a failed callback and describes it as an I/O error.
fn failed(function: &str, host: &str, err: &CallbackError) -> io::Error {
    tracing::warn!(
        target: "lkrequest_napi::bridge",
        host,
        error = %err,
        "dns {function} failed"
    );
    io::Error::other(format!("dns {function} for {host:?}: {err}"))
}

/// An address the resolver returned: an IP (the requested port applies) or `ip:port`.
fn parse_address(answer: &str, port: u16) -> io::Result<SocketAddr> {
    let address = answer
        .parse::<SocketAddr>()
        .ok()
        .or_else(|| {
            answer
                .parse::<IpAddr>()
                .ok()
                .map(|ip| SocketAddr::new(ip, port))
        })
        .filter(|address| address.port() != 0);
    address.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "the resolver returned {answer:?}, which is not an IP address with an optional \
                 non-zero port (IPv6 with a port as \"[::1]:443\")"
            ),
        )
    })
}

impl NativeHttpsRecord {
    /// Upstream's record, refusing what upstream's own parser would discard.
    fn into_upstream(self) -> Result<HttpsRecord, String> {
        let alpn = self.alpn.unwrap_or_default();
        let no_default_alpn = self.no_default_alpn.unwrap_or(false);
        if no_default_alpn && alpn.is_empty() {
            return Err("an HTTPS record with noDefaultAlpn needs an alpn list".to_owned());
        }
        let port = self
            .port
            .map(|port| {
                u16::try_from(port)
                    .ok()
                    .filter(|&port| port != 0)
                    .ok_or_else(|| format!("the HTTPS record's port {port} is not 1 to 65535"))
            })
            .transpose()?;
        Ok(HttpsRecord {
            ech_config_list: self.ech.map(|ech| ech.0.to_vec()),
            alpn,
            no_default_alpn,
            target: self.target,
            port,
            ipv4_hints: hints::<Ipv4Addr>(self.ipv4_hints, "ipv4Hints")?,
            ipv6_hints: hints::<Ipv6Addr>(self.ipv6_hints, "ipv6Hints")?,
        })
    }
}

/// Parses address hints of one family.
fn hints<T: std::str::FromStr>(hints: Option<Vec<String>>, name: &str) -> Result<Vec<T>, String> {
    hints
        .unwrap_or_default()
        .iter()
        .map(|hint| {
            hint.parse::<T>()
                .map_err(|_| format!("the HTTPS record's {name} entry {hint:?} is not an address"))
        })
        .collect()
}
