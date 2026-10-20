# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue, pull request or discussion for
them: that could expose other users before a fix is available.

- GitHub: use "Report a vulnerability" under this repository's **Security** tab
  ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
- Email: admin@ez-xlabs.com, with the subject prefixed `[lkrequest-js security]`.

Please include the affected version (`import { version } from "lkrequest"`), your Node.js
version and platform, what the issue allows, and a minimal reproduction. Leave real
credentials, cookies and TLS key logs out of the report.

We aim to acknowledge a report within a few business days. We follow coordinated disclosure:
please give us a reasonable window to ship a fix before you disclose the issue publicly, and we
will credit reporters who want to be named. This is pre-1.0 software, so response times are
best-effort and not backed by an SLA.

## Scope

lkrequest-js is an HTTP client that terminates TLS, talks to proxies and emulates browser
fingerprints, with native code running inside the Node.js process. Reports in these areas are
especially welcome:

- Memory safety at the native boundary: the buffers handed to JavaScript without a copy, the
  bridge that calls JavaScript functions from Rust threads, and anything else that can crash or
  corrupt the process.
- Certificate verification: `rejectUnauthorized` and the custom CA options (`ca`, `caDer`,
  `useNativeCerts`).
- Credential handling: proxy credentials (`ProxyConfig`, `withUserPass`, `withCustomAuth`),
  `Authorization` values, cookies and TLS key logs (`tls.keylog`) that end up in logs, in error
  messages or on another connection.
- The supply chain: the npm packages (`lkrequest` and the `@lkrequest/binding-*` platform
  packages) and the build and release workflows in `.github/workflows/`.

A vulnerability in the Rust library itself (the TLS, HTTP/2 and HTTP/3 stacks, the proxy
protocols), as opposed to this binding, belongs to the
[lkrequest](https://github.com/EZXLabs/lkrequest-rs) repository. If you are not sure where it
belongs, report it here and we will route it.

## Supported versions

Security fixes go into the latest release. lkrequest-js has not reached 1.0; older versions
are handled on a best-effort basis and are not backported.

## Intended use and responsible use

lkrequest-js gives byte-level control over TLS, HTTP/2 and HTTP/3 wire formats so that requests
can match the network fingerprints of real browsers. That capability is intended for
**legitimate, authorized use only**.

Intended uses include:

- Authorized security testing and red-team engagements where you have explicit permission to
  test the target.
- Research on anti-bot systems, fingerprinting and browser emulation.
- Web scraping and automation of sites that you own or are explicitly authorized to access,
  in compliance with their terms.
- Building and validating tools that check browser fidelity and fingerprint consistency.
- Privacy and network-protocol research and education.

You must **not** use lkrequest-js to:

- Bypass authentication, authorization or other access controls on systems you do not own or
  are not authorized to access.
- Violate a site's terms of service, robots directives, rate limits or applicable laws and
  regulations, including computer-misuse, anti-fraud and data-protection law.
- Evade or defeat fraud-prevention, abuse-prevention or security controls in order to commit
  fraud, abuse or other unlawful activity.
- Conduct credential stuffing, denial-of-service attacks, spam, scalping, ad fraud or any other
  abusive or malicious activity.
- Misrepresent your identity or affiliation in a way that is deceptive or unlawful.

You are solely responsible for making sure that your use of this software is lawful and
authorized in your jurisdiction and for the systems you interact with. The maintainers and
contributors provide it as is, for research and legitimate engineering purposes, and accept no
responsibility for misuse. See [LICENSE](LICENSE) (Apache-2.0) for the full warranty disclaimer
and limitation of liability.
