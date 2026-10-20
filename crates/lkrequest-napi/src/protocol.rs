//! Protocol selection options: policies, intents, version preferences, QUIC failure handling,
//! HTTP/3 retries, idempotency and request priority.
//!
//! Every option arrives as the snake_case name of the upstream identifier; the facade's types
//! restrict the spellings, these parsers are the native guard.

use lkrequest::lkh2::RequestPriority;
use lkrequest::session::SessionBuilder;
use lkrequest::{
    AcquisitionPolicy, BrokenQuicConfig, BrokenQuicPolicy, FallbackPolicy, HttpIntent, Idempotency,
    PreferredHttpVersion, ProtocolPolicy, RacePolicy, UpgradePolicy,
};
use napi_derive::napi;

use crate::error::invalid_arg;
use crate::types::{duration_from_ms, usize_from};

/// A request priority (RFC 9218): a preset name, or an urgency with an incremental flag.
#[napi(object, object_to_js = false)]
pub struct NativePriority {
    /// `navigation`, `fetch`, `css`, `script`, `image` or `background`.
    pub preset: Option<String>,
    /// Urgency from 0 (highest) to 7; larger values are clamped to 7.
    pub urgency: Option<u32>,
    /// Whether the response can be processed incrementally.
    pub incremental: Option<bool>,
}

/// A protocol policy: a preset, adjusted axis by axis. Unset axes keep the value of the
/// starting policy.
#[napi(object, object_to_js = false)]
pub struct NativeProtocolPolicy {
    /// Preset to start from: `chrome_standard`, `chrome_conservative`, `crawler_throughput` or
    /// `h3_strict`. Without one, the policy in force at the level being configured is the start.
    pub preset: Option<String>,
    /// `h2_only`, `h3_only`, `acquire_h3_when_viable` or `reuse_existing_protocol`.
    pub intent: Option<String>,
    /// `reuse_existing_first`, `establish_best_available` or `race`.
    pub acquisition: Option<String>,
    /// Parameters of `acquisition: "race"`.
    pub race: Option<NativeRacePolicy>,
    /// `off`, `probe_only`, `probe_and_migrate` or `force_for_new_requests`.
    pub upgrade: Option<String>,
    /// `allow_fallback`, `allow_fallback_on_network_errors` or `no_fallback`.
    pub fallback: Option<String>,
}

/// Parameters of a TCP-versus-QUIC race; unset ones keep upstream's Chrome-like values.
#[napi(object, object_to_js = false)]
pub struct NativeRacePolicy {
    /// Start a TCP attempt.
    pub tcp: Option<bool>,
    /// Start a QUIC attempt.
    pub quic: Option<bool>,
    /// Delay before the TCP attempt starts, in milliseconds.
    pub tcp_delay: Option<f64>,
    /// Delay before the QUIC attempt starts, in milliseconds.
    pub quic_delay: Option<f64>,
    /// Race only when the route has already advertised HTTP/3.
    pub only_when_h3_advertised: Option<bool>,
}

/// The policy `spec` describes, validated. `base` is the policy in force at the level being
/// configured (the client's, the session's): it is the starting point unless `spec` names a
/// preset, so `{ fallback: "no_fallback" }` changes one axis and nothing else.
///
/// An intent goes first because upstream's `with_intent` also brings the other axes in line
/// with it (`h2_only` forbids fallback and upgrades); the axes given explicitly then override
/// that, and a combination that contradicts itself is refused.
pub(crate) fn protocol_policy(
    spec: &NativeProtocolPolicy,
    base: &ProtocolPolicy,
) -> napi::Result<ProtocolPolicy> {
    let mut policy = match &spec.preset {
        Some(name) => protocol_policy_preset(name)?,
        None => base.clone(),
    };
    if let Some(name) = &spec.intent {
        policy = policy.with_intent(http_intent(name)?);
    }
    if let Some(acquisition) = acquisition_policy(spec)? {
        policy = policy.with_acquisition(acquisition);
    }
    if let Some(name) = &spec.upgrade {
        policy = policy.with_upgrade(upgrade_policy(name)?);
    }
    if let Some(name) = &spec.fallback {
        policy = policy.with_fallback(fallback_policy(name)?);
    }
    policy
        .validate()
        .map_err(|err| invalid_arg(format!("invalid protocolPolicy: {err}")))?;
    Ok(policy)
}

/// A protocol policy preset by name.
fn protocol_policy_preset(name: &str) -> napi::Result<ProtocolPolicy> {
    match name {
        "chrome_standard" => Ok(ProtocolPolicy::chrome_standard()),
        "chrome_conservative" => Ok(ProtocolPolicy::chrome_conservative()),
        "crawler_throughput" => Ok(ProtocolPolicy::crawler_throughput()),
        "h3_strict" => Ok(ProtocolPolicy::h3_strict()),
        _ => Err(unknown(
            "protocolPolicy",
            name,
            "chrome_standard, chrome_conservative, crawler_throughput, h3_strict",
        )),
    }
}

/// The acquisition policy `spec` asks for, if it asks for one.
fn acquisition_policy(spec: &NativeProtocolPolicy) -> napi::Result<Option<AcquisitionPolicy>> {
    let race = spec.race.as_ref();
    match (spec.acquisition.as_deref(), race) {
        (None, None) => Ok(None),
        (Some("race"), _) => Ok(Some(AcquisitionPolicy::Race(race_policy(race)?))),
        (Some(_), Some(_)) | (None, Some(_)) => Err(invalid_arg(
            "race options are only meaningful with acquisition \"race\"",
        )),
        (Some("reuse_existing_first"), None) => Ok(Some(AcquisitionPolicy::ReuseExistingFirst)),
        (Some("establish_best_available"), None) => {
            Ok(Some(AcquisitionPolicy::EstablishBestAvailable))
        }
        (Some(name), None) => Err(unknown(
            "acquisition",
            name,
            "reuse_existing_first, establish_best_available, race",
        )),
    }
}

/// The race parameters: upstream's Chrome-like defaults with `race`'s settings on top.
fn race_policy(race: Option<&NativeRacePolicy>) -> napi::Result<RacePolicy> {
    let mut policy = RacePolicy::chrome_like();
    let Some(race) = race else {
        return Ok(policy);
    };
    if let Some(enabled) = race.tcp {
        policy.enable_tcp = enabled;
    }
    if let Some(enabled) = race.quic {
        policy.enable_quic = enabled;
    }
    if let Some(ms) = race.tcp_delay {
        policy.tcp_delay = duration_from_ms(ms, "protocolPolicy.acquisition.race.tcpDelay")?;
    }
    if let Some(ms) = race.quic_delay {
        policy.quic_delay = duration_from_ms(ms, "protocolPolicy.acquisition.race.quicDelay")?;
    }
    if let Some(only) = race.only_when_h3_advertised {
        policy.only_when_h3_advertised = only;
    }
    Ok(policy)
}

/// How HTTP/3 is adopted after a TCP connection, by name.
fn upgrade_policy(name: &str) -> napi::Result<UpgradePolicy> {
    match name {
        "off" => Ok(UpgradePolicy::Off),
        "probe_only" => Ok(UpgradePolicy::ProbeOnly),
        "probe_and_migrate" => Ok(UpgradePolicy::ProbeAndMigrate),
        "force_for_new_requests" => Ok(UpgradePolicy::ForceForNewRequests),
        _ => Err(unknown(
            "upgrade",
            name,
            "off, probe_only, probe_and_migrate, force_for_new_requests",
        )),
    }
}

/// When a failed QUIC attempt may fall back to TCP, by name.
fn fallback_policy(name: &str) -> napi::Result<FallbackPolicy> {
    match name {
        "allow_fallback" => Ok(FallbackPolicy::AllowFallback),
        "allow_fallback_on_network_errors" => Ok(FallbackPolicy::AllowFallbackOnNetworkErrors),
        "no_fallback" => Ok(FallbackPolicy::NoFallback),
        _ => Err(unknown(
            "fallback",
            name,
            "allow_fallback, allow_fallback_on_network_errors, no_fallback",
        )),
    }
}

/// An HTTP/2 versus HTTP/3 intent by name.
pub(crate) fn http_intent(name: &str) -> napi::Result<HttpIntent> {
    match name {
        "h2_only" => Ok(HttpIntent::H2Only),
        "h3_only" => Ok(HttpIntent::H3Only),
        "acquire_h3_when_viable" => Ok(HttpIntent::AcquireH3WhenViable),
        "reuse_existing_protocol" => Ok(HttpIntent::ReuseExistingProtocol),
        _ => Err(unknown(
            "httpIntent",
            name,
            "h2_only, h3_only, acquire_h3_when_viable, reuse_existing_protocol",
        )),
    }
}

/// An HTTP version preference by name.
pub(crate) fn preferred_http_version(name: &str) -> napi::Result<PreferredHttpVersion> {
    match name {
        "auto" => Ok(PreferredHttpVersion::Auto),
        "http1_only" => Ok(PreferredHttpVersion::Http1Only),
        "http2_only" => Ok(PreferredHttpVersion::Http2Only),
        "http3_only" => Ok(PreferredHttpVersion::Http3Only),
        "http3_with_fallback" => Ok(PreferredHttpVersion::Http3WithFallback),
        _ => Err(unknown(
            "preferredHttpVersion",
            name,
            "auto, http1_only, http2_only, http3_only, http3_with_fallback",
        )),
    }
}

/// How an origin whose QUIC connection failed is avoided: a preset, or cooldown settings.
/// Durations are in milliseconds.
#[napi(object, object_to_js = false)]
pub struct NativeBrokenQuicPolicy {
    /// `strict`, `resilient` or `disabled`. Leave it unset to give the settings below.
    pub preset: Option<String>,
    /// Cooldown after the first failure of an origin (default 300000).
    pub initial_cooldown: Option<f64>,
    /// Longest cooldown after repeated failures (default 3600000).
    pub max_cooldown: Option<f64>,
    /// Consecutive failures after which the cooldown is the longest (default 4).
    pub escalation_threshold: Option<u32>,
    /// Cooldown of a whole proxy route that cannot carry QUIC (default 1800000).
    pub route_cooldown: Option<f64>,
    /// Origins tracked at most (default 1024).
    pub max_entries: Option<f64>,
    /// Proxy routes tracked at most (default 256).
    pub max_route_entries: Option<f64>,
}

/// The QUIC failure policy `spec` describes: a preset, or upstream's `strict` settings with
/// the given ones on top.
pub(crate) fn broken_quic_policy(spec: &NativeBrokenQuicPolicy) -> napi::Result<BrokenQuicPolicy> {
    let custom = spec.initial_cooldown.is_some()
        || spec.max_cooldown.is_some()
        || spec.escalation_threshold.is_some()
        || spec.route_cooldown.is_some()
        || spec.max_entries.is_some()
        || spec.max_route_entries.is_some();
    match (&spec.preset, custom) {
        (Some(name), false) => broken_quic_preset(name),
        (Some(_), true) => Err(invalid_arg(
            "brokenQuicPolicy takes a preset name or cooldown settings, not both",
        )),
        (None, _) => Ok(BrokenQuicPolicy::Custom(broken_quic_config(spec)?)),
    }
}

/// A QUIC failure policy preset by name.
fn broken_quic_preset(name: &str) -> napi::Result<BrokenQuicPolicy> {
    match name {
        "strict" => Ok(BrokenQuicPolicy::Strict),
        "resilient" => Ok(BrokenQuicPolicy::Resilient),
        "disabled" => Ok(BrokenQuicPolicy::Disabled),
        _ => Err(unknown(
            "brokenQuicPolicy",
            name,
            "strict, resilient, disabled",
        )),
    }
}

/// Upstream's tracker settings. Upstream clamps or tolerates values that make no sense (a
/// first cooldown above the longest, a table of zero entries); they are refused here instead.
fn broken_quic_config(spec: &NativeBrokenQuicPolicy) -> napi::Result<BrokenQuicConfig> {
    let mut config = BrokenQuicConfig::default();
    let ms = |value: f64, name: &str| duration_from_ms(value, &format!("brokenQuicPolicy.{name}"));
    if let Some(value) = spec.initial_cooldown {
        config.initial_cooldown = ms(value, "initialCooldown")?;
    }
    if let Some(value) = spec.max_cooldown {
        config.max_cooldown = ms(value, "maxCooldown")?;
    }
    if config.initial_cooldown > config.max_cooldown {
        return Err(invalid_arg(format!(
            "brokenQuicPolicy.initialCooldown ({} ms) must not exceed maxCooldown ({} ms)",
            config.initial_cooldown.as_millis(),
            config.max_cooldown.as_millis()
        )));
    }
    if let Some(threshold) = spec.escalation_threshold {
        if threshold == 0 {
            return Err(invalid_arg(
                "brokenQuicPolicy.escalationThreshold must be at least 1",
            ));
        }
        config.failure_escalation_threshold = threshold;
    }
    if let Some(value) = spec.route_cooldown {
        config.route_cooldown = ms(value, "routeCooldown")?;
    }
    if let Some(value) = spec.max_entries {
        config.max_entries = at_least_one(value, "brokenQuicPolicy.maxEntries")?;
    }
    if let Some(value) = spec.max_route_entries {
        config.max_route_entries = at_least_one(value, "brokenQuicPolicy.maxRouteEntries")?;
    }
    Ok(config)
}

/// A table size, which must hold at least one entry.
fn at_least_one(value: f64, name: &str) -> napi::Result<usize> {
    match usize_from(value, name)? {
        0 => Err(invalid_arg(format!("{name} must be at least 1"))),
        n => Ok(n),
    }
}

/// Applies the session's HTTP/3 protocol-error retry mode, by name.
#[cfg(feature = "quic-h3")]
pub(crate) fn h3_retry_mode(builder: SessionBuilder, name: &str) -> napi::Result<SessionBuilder> {
    use lkrequest::H3RetryMode;
    let mode = match name {
        "safe" => H3RetryMode::Safe,
        "chrome_155_protocol_errors" => H3RetryMode::Chrome155ProtocolErrors,
        _ => return Err(unknown_h3_retry_mode(name)),
    };
    Ok(builder.h3_retry_mode(mode))
}

/// Without HTTP/3 nothing is retried: only `safe`, the default, is accepted.
#[cfg(not(feature = "quic-h3"))]
pub(crate) fn h3_retry_mode(builder: SessionBuilder, name: &str) -> napi::Result<SessionBuilder> {
    match name {
        "safe" => Ok(builder),
        "chrome_155_protocol_errors" => Err(invalid_arg(
            "h3RetryMode chrome_155_protocol_errors needs a build with the quic-h3 feature",
        )),
        _ => Err(unknown_h3_retry_mode(name)),
    }
}

/// The error for an `h3RetryMode` outside its vocabulary.
fn unknown_h3_retry_mode(name: &str) -> napi::Error {
    unknown("h3RetryMode", name, "safe, chrome_155_protocol_errors")
}

/// A request's idempotency declaration by name.
pub(crate) fn idempotency(name: &str) -> napi::Result<Idempotency> {
    match name {
        "default" => Ok(Idempotency::Default),
        "idempotent" => Ok(Idempotency::Idempotent),
        "not_idempotent" => Ok(Idempotency::NotIdempotent),
        _ => Err(unknown(
            "idempotency",
            name,
            "default, idempotent, not_idempotent",
        )),
    }
}

/// The upstream priority described by `priority`.
pub(crate) fn priority(priority: &NativePriority) -> napi::Result<RequestPriority> {
    let Some(name) = &priority.preset else {
        let urgency = priority.urgency.unwrap_or(3);
        // `custom` clamps to 7 itself; saturate first so a huge value cannot wrap.
        let urgency = u8::try_from(urgency).unwrap_or(u8::MAX);
        return Ok(RequestPriority::custom(
            urgency,
            priority.incremental.unwrap_or(false),
        ));
    };
    match name.as_str() {
        "navigation" => Ok(RequestPriority::navigation()),
        "fetch" => Ok(RequestPriority::fetch()),
        "css" => Ok(RequestPriority::css()),
        "script" => Ok(RequestPriority::script()),
        "image" => Ok(RequestPriority::image()),
        "background" => Ok(RequestPriority::background()),
        _ => Err(unknown(
            "priority",
            name,
            "navigation, fetch, css, script, image, background",
        )),
    }
}

/// The error for a name outside an option's vocabulary.
fn unknown(option: &str, name: &str, expected: &str) -> napi::Error {
    invalid_arg(format!(
        "unknown {option} {name:?}; expected one of {expected}"
    ))
}
