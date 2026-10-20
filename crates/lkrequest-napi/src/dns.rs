//! Name resolution and address selection: `dns`, `dnsCache`, `family` and `connectTo`.
//!
//! Ported from lkrequest-py's `resolve_dns_config` and `src/dns.rs`. Upstream implements the
//! family policy and the dial overrides; this module only turns the facade's options into
//! upstream's types, rejecting what upstream would panic on (a zero port) or would report only
//! once a request is sent (an override outside the family). The DNS server option and the
//! JavaScript resolver go beyond lkrequest-py: upstream has `DnsConfig::Custom` and the
//! `DnsResolver` trait, which Python never exposed.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use lkrequest::client::ClientBuilder;
use lkrequest::{DnsConfig, IpFamily, SystemDnsCacheConfig};
use napi_derive::napi;

use crate::error::invalid_arg;
use crate::resolver::{JsResolver, LookupHttpsFn, ResolveFn};
use crate::types::{duration_from_ms, usize_from};

/// One `connectTo` entry: requests to `host:port` dial `address` instead.
#[napi(object, object_to_js = false)]
pub struct NativeDialOverride {
    /// Origin host, already normalized by the facade (lower-case, IPv6 in brackets).
    pub host: String,
    /// Origin port.
    pub port: u32,
    /// Address to dial, as `ip:port` (IPv6 in brackets).
    pub address: String,
}

/// The name-resolution options of a client.
pub(crate) struct DnsOptions<'a> {
    /// Resolver preset name.
    pub dns: Option<&'a str>,
    /// A DNS server to query directly: an IP address with an optional port.
    pub server: Option<&'a str>,
    /// A resolver written in JavaScript: its `resolve` and, optionally, its `lookupHttps`.
    pub resolver: Option<(ResolveFn, Option<LookupHttpsFn>)>,
    /// Positive-result cache TTL for the system resolver, in milliseconds.
    pub cache_ttl: Option<f64>,
    /// Entry cap of that cache.
    pub cache_max_entries: Option<f64>,
    /// Address family: 0 (any), 4 or 6, as in Node's `net` module.
    pub family: Option<u32>,
    /// Fixed addresses to dial per origin.
    pub connect_to: Option<&'a [NativeDialOverride]>,
}

/// Applies the resolver, its cache, the family policy and the dial overrides.
pub(crate) fn configure(
    mut builder: ClientBuilder,
    options: DnsOptions<'_>,
) -> napi::Result<ClientBuilder> {
    // Upstream lets the last resolver setter win, so combining two of them would silently
    // drop one. The facade's `dns` option holds one form at a time; the cache implies the
    // system resolver.
    let forms = [
        options.dns.is_some(),
        options.server.is_some(),
        options.resolver.is_some(),
    ];
    if forms.into_iter().filter(|&set| set).count() > 1 {
        return Err(invalid_arg(
            "dns takes a resolver preset, a server or a resolver of your own, not several",
        ));
    }
    if options.cache_ttl.is_some() && forms.into_iter().any(|set| set) {
        return Err(invalid_arg(
            "dnsCache cannot be combined with dns: the cache already selects the system resolver",
        ));
    }
    if options.cache_max_entries.is_some() && options.cache_ttl.is_none() {
        return Err(invalid_arg("dnsCache.maxEntries requires dnsCache.ttl"));
    }
    if let Some(ttl) = options.cache_ttl {
        let mut cache = SystemDnsCacheConfig::positive(duration_from_ms(ttl, "dnsCache.ttl")?);
        if let Some(n) = options.cache_max_entries {
            cache = cache.with_max_entries(usize_from(n, "dnsCache.maxEntries")?);
        }
        builder = builder.system_dns_cache(cache);
    } else if let Some(spec) = options.server {
        builder = builder.dns(DnsConfig::Custom(dns_server(spec)?));
    } else if let Some((resolve, lookup_https)) = options.resolver {
        // Upstream wraps whichever resolver is configured in the client's DNS timeout.
        builder = builder.dns_resolver(Arc::new(JsResolver::new(resolve, lookup_https)));
    } else if let Some(name) = options.dns {
        builder = builder.dns(dns_config(name)?);
    }
    // Upstream applies the family policy to whichever resolver is configured.
    let family = ip_family(options.family.unwrap_or(0))?;
    builder = builder.ip_family(family);
    for entry in dial_overrides(options.connect_to.unwrap_or_default(), family)? {
        builder = builder.connect_to(&entry.0, entry.1, entry.2);
    }
    Ok(builder)
}

/// A resolver preset by name.
fn dns_config(name: &str) -> napi::Result<DnsConfig> {
    match name {
        "system" => Ok(DnsConfig::System),
        "google" => Ok(DnsConfig::Google),
        "cloudflare" => Ok(DnsConfig::Cloudflare),
        "quad9" => Ok(DnsConfig::Quad9),
        #[cfg(feature = "doh")]
        "google_https" => Ok(DnsConfig::GoogleHttps),
        #[cfg(feature = "doh")]
        "cloudflare_https" => Ok(DnsConfig::CloudflareHttps),
        #[cfg(feature = "doh")]
        "quad9_https" => Ok(DnsConfig::Quad9Https),
        #[cfg(not(feature = "doh"))]
        "google_https" | "cloudflare_https" | "quad9_https" => Err(invalid_arg(format!(
            "dns {name:?} requires building lkrequest-js with the 'doh' feature"
        ))),
        _ => Err(invalid_arg(format!(
            "unknown dns {name:?}; expected one of system, google, cloudflare, quad9, \
             google_https, cloudflare_https, quad9_https"
        ))),
    }
}

/// The port DNS servers listen on unless told otherwise.
const DNS_PORT: u16 = 53;

/// The address of a DNS server written as `ip` or `ip:port`, with IPv6 as `[ip]:port` or bare
/// (then without a port), like Node's `dns.setServers()`. A host name is refused: resolving
/// it would need the resolver being configured.
fn dns_server(spec: &str) -> napi::Result<SocketAddr> {
    let address = spec
        .parse::<SocketAddr>()
        .ok()
        .or_else(|| {
            spec.parse::<IpAddr>()
                .ok()
                .map(|ip| SocketAddr::new(ip, DNS_PORT))
        })
        .filter(|address| address.port() != 0);
    address.ok_or_else(|| {
        invalid_arg(format!(
            "dns.server {spec:?} must be an IP address with an optional non-zero port, such as \
             \"1.1.1.1\", \"1.1.1.1:5353\" or \"[2606:4700::1111]:53\""
        ))
    })
}

/// The family policy for Node's numeric spelling.
fn ip_family(family: u32) -> napi::Result<IpFamily> {
    match family {
        0 => Ok(IpFamily::Any),
        4 => Ok(IpFamily::Ipv4),
        6 => Ok(IpFamily::Ipv6),
        _ => Err(invalid_arg(format!(
            "family must be 0, 4 or 6, not {family}"
        ))),
    }
}

/// Whether `ip` is an address `family` permits. Mirrors upstream's rule, including that
/// IPv6 excludes IPv4-mapped addresses (`::ffff:a.b.c.d`), which carry IPv4 traffic.
fn family_allows(family: IpFamily, ip: IpAddr) -> bool {
    match family {
        IpFamily::Any => true,
        IpFamily::Ipv4 => ip.is_ipv4(),
        IpFamily::Ipv6 => matches!(ip, IpAddr::V6(v6) if v6.to_ipv4_mapped().is_none()),
    }
}

/// Node's spelling of a family, for error messages.
fn family_label(family: IpFamily) -> u8 {
    match family {
        IpFamily::Any => 0,
        IpFamily::Ipv4 => 4,
        IpFamily::Ipv6 => 6,
    }
}

/// Validates the dial overrides as `(host, port, address)` triples.
fn dial_overrides(
    entries: &[NativeDialOverride],
    family: IpFamily,
) -> napi::Result<Vec<(String, u16, SocketAddr)>> {
    let mut overrides: Vec<(String, u16, SocketAddr)> = Vec::with_capacity(entries.len());
    for entry in entries {
        let origin = format!("{}:{}", entry.host, entry.port);
        let port = u16::try_from(entry.port)
            .ok()
            .filter(|&port| port != 0)
            .ok_or_else(|| invalid_arg(format!("connectTo key {origin:?} has an invalid port")))?;
        // Upstream keys its table by host and port, so a duplicate would silently replace
        // the earlier entry.
        if overrides
            .iter()
            .any(|(host, p, _)| *host == entry.host && *p == port)
        {
            return Err(invalid_arg(format!(
                "connectTo lists {origin} more than once"
            )));
        }
        let address = entry
            .address
            .parse::<SocketAddr>()
            .ok()
            .filter(|address| address.port() != 0)
            .ok_or_else(|| {
                invalid_arg(format!(
                    "connectTo value {:?} for {origin} must be \"ip:port\" with a non-zero port \
                     (IPv6 as \"[2001:db8::1]:443\")",
                    entry.address
                ))
            })?;
        if !family_allows(family, address.ip()) {
            return Err(invalid_arg(format!(
                "connectTo maps {origin} to {address}, which family {} excludes",
                family_label(family)
            )));
        }
        overrides.push((entry.host.clone(), port, address));
    }
    Ok(overrides)
}
