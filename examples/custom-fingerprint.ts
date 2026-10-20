// Custom fingerprints
//
// A fingerprint has layers: the TLS handshake, the HTTP/2 settings and the TCP behavior. A preset
// fills in all of them. You can replace any layer, or build one by hand.
//
// Run: node examples/custom-fingerprint.ts (see examples/README.md)

import {
  Client,
  H2Profile,
  TcpFingerprint,
  TlsProfile,
  validateFingerprintConsistency,
} from "lkrequest";

// Layers from presets...
const tls = TlsProfile.preset("chrome_155");
const h2 = H2Profile.preset("chrome_155");

// ...and one built by hand. These are the values Chrome on Windows sends.
const tcp = TcpFingerprint.create({
  windowSize: 64_240,
  tcpOptions: [2, 1, 3, 1, 1, 4],
  mss: 1460,
  windowScale: 8,
});
console.log(tcp.toJa4t()); // 64240_2-1-3-1-1-4_1460_8

// A mix of browsers is easy to spot. This checks that the layers belong to one family.
console.log(
  validateFingerprintConsistency({
    tlsProfile: "chrome_155",
    h2Profile: "chrome_155",
    tcpFingerprint: "chrome_win",
  }),
);
console.log(validateFingerprintConsistency({ tlsProfile: "chrome_155", h2Profile: "firefox_156" }));

const client = new Client({ tlsProfile: tls, h2Profile: h2, tcpFingerprint: tcp });
console.log(client.fingerprintInfo());
console.log((await client.get("https://httpbin.org/get")).status);

// A profile is plain JSON, in the format lkrequest-py reads too: save it, edit it, load it.
const loaded = TlsProfile.fromJSON(JSON.stringify(tls));
console.log(loaded.name, loaded.cipherSuites.length, "cipher suites");

// Chrome shuffles the order of the TLS extensions on every connection. This does the same.
const shuffled = new Client({ preset: "chrome_155", randomize: "extension_order" });
console.log((await shuffled.get("https://httpbin.org/get")).status);
