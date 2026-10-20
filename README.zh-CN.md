<h1 align="center">lkrequest</h1>

<p align="center">
  <strong>基于 Rust 的 Node.js HTTP 客户端，支持字节级的 TLS、HTTP/2 和 HTTP/3 指纹控制。</strong>
</p>

<p align="center">
  浏览器预设 · 代理与各种池 · WebSocket · HTTP/3 · 类 fetch 的 API
</p>

<p align="center">
  <a href="https://github.com/EZXLabs/lkrequest-js/actions/workflows/ci.yml"><img alt="CI 状态" src="https://img.shields.io/github/actions/workflow/status/EZXLabs/lkrequest-js/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://www.npmjs.com/package/lkrequest"><img alt="npm 版本" src="https://img.shields.io/npm/v/lkrequest?style=flat-square&logo=npm&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/lkrequest"><img alt="npm 下载量" src="https://img.shields.io/npm/dm/lkrequest?style=flat-square&label=downloads"></a>
  <img alt="Node.js 22.12 或更高版本" src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="自带 TypeScript 类型" src="https://img.shields.io/badge/types-included-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="基于 Rust" src="https://img.shields.io/badge/powered%20by-Rust-CE422B?style=flat-square&logo=rust&logoColor=white">
  <img alt="平台：Linux、macOS 和 Windows" src="https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows-lightgrey?style=flat-square">
  <a href="LICENSE"><img alt="许可证：Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#使用指南">使用指南</a> ·
  <a href="examples/README.md">示例</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href="README.md">English</a>
</p>

lkrequest 让你决定请求在网络上的样子。它可以复现真实浏览器的 TLS 握手、HTTP/2 设置、HTTP/3 与 QUIC 参数和 TCP 选项，也可以发送你自己构建的指纹，并通过类 `fetch` 的 API 提供会话、Cookie、代理、WebSocket 和带类型的错误。

## 主要特性

- **浏览器预设** — Chrome 131、144–155，Firefox 133/147/156，Safari 18/26。每个预设同时设置 TLS 握手、HTTP/2 设置和 TCP 指纹，Chrome 预设还带有 HTTP/3 与 QUIC。
- **可编程的指纹** — 手工构建、从 JSON 或抓包数据构建 TLS、HTTP/2、TCP 指纹，检查各层是否搭配得当，并让 TLS 扩展顺序在每个连接上随机变化。
- **HTTP/1.1、HTTP/2 和 HTTP/3** — 按会话或按请求选择版本，也可以交给协议策略决定何时让 TCP 与 QUIC 竞速、何时回退。
- **代理** — HTTP CONNECT、SOCKS5、SOCKS5h、多跳代理链和 MASQUE（实验性），配套代理池、健康检查，以及每个连接现算的凭据。
- **熟悉的 API** — 类 `fetch` 的响应和请求体（`FormData`、`URLSearchParams`、`Blob`、带背压的流）、`AbortSignal`，以及带错误码、失败阶段和重试提示的类型化错误。
- **会话** — 独立的 Cookie 存储（Playwright / Puppeteer 格式）、连接池、重定向控制、重试、middleware、钩子和 HSTS。
- **WebSocket** — `wss://` 连接沿用会话的指纹、Cookie 和代理。
- **网络控制** — 系统解析器（可带缓存）、公共 DNS、DNS over HTTPS，或者你自己的解析函数；可以只用 IPv4 或只用 IPv6；还能为主机固定拨号地址。
- **可观测性** — 每个响应的分阶段耗时、`node:diagnostics_channel` 事件、Prometheus 格式的计数器、日志事件，以及给 Wireshark 用的 TLS 密钥日志。
- **安装简单** — 提供 Linux、macOS、Windows 的 x64 与 arm64 预编译二进制，不需要 Rust 工具链或编译器；自带 TypeScript 类型。

## 安装

```bash
npm install lkrequest
# 或：pnpm add lkrequest · yarn add lkrequest
```

lkrequest 需要 **Node.js 22.12 或更高版本**。它是 ES module 包，CommonJS 代码可以用 `import()` 或 `require()` 加载。

原生扩展按平台提供预编译包（`@lkrequest/binding-*`），包管理器会安装与你的系统匹配的那一个：**Linux**（glibc 2.28 及以上，以及 Alpine 等 musl）、**macOS** 和 **Windows**，均支持 x64 与 arm64。

## 快速开始

```ts
import { Client } from "lkrequest";

// Client 负责指纹和连接配置。
const client = new Client({ preset: "chrome_155" });

// Session 负责 Cookie 和连接，同一个会话的请求共用它们。
const session = client.session({ baseUrl: "https://httpbin.org" });

const res = await session.get("/get", { params: { q: "lkrequest" } });
console.log(res.status, res.httpVersion); // 200 2.0
console.log(await res.json());
```

只发一个请求时，`client.get(url)` 会用一个临时会话发出请求，发完即关闭。不指定 `preset` 时，客户端使用默认指纹：Chrome 155 的 TLS 和 HTTP/2，不启用 HTTP/3。

## 使用指南

### 浏览器指纹

预设让客户端在协议层面看起来像真实的浏览器：它设置 TLS 握手、HTTP/2 设置和 TCP 指纹，Chrome 预设还设置 HTTP/3 与 QUIC 参数。`listPresets()` 会列出当前构建里的全部预设。

```ts
import { Client, listPresets } from "lkrequest";

// 当前构建已知的全部预设，形如 { name: "chrome_155", browser: "chrome", http3: true }
console.log(listPresets());

const client = new Client({
  preset: "chrome_155",
  // 预设只设置指纹，不设置请求头的取值：浏览器会发的头要自己加上。
  defaultHeaders: {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
  },
});

// 让指纹回显服务告诉你它看到了什么。任何会报告 JA3 或 JA4 的服务都可以。
const res = await client.get("https://tls.peet.ws/api/clean");
const seen = await res.json<{ ja4: string; akamai_hash: string }>();
console.log(seen.ja4, seen.akamai_hash); // TLS（JA4）与 HTTP/2（Akamai）指纹
```

`ClientPool` 会轮流交出多个客户端，让流量不至于始终带着同一个指纹：

```ts
import { Client, ClientPool } from "lkrequest";

const pool = new ClientPool([
  new Client({ preset: "chrome_155" }),
  new Client({ preset: "firefox_156" }),
  new Client({ preset: "safari_26" }),
]);

const res = await pool.acquire().get("https://httpbin.org/get");
console.log(res.status);
```

### 请求与响应

请求体和响应遵循 Fetch 标准。`body` 可以是字符串、二进制数据、`Blob`、`URLSearchParams`、`FormData` 或流，`json` 会帮你序列化一个值。

```ts
import { Client } from "lkrequest";

const session = new Client().session({ baseUrl: "https://httpbin.org" });

const res = await session.post("/post", {
  params: { source: "readme" }, // 查询字符串：?source=readme
  headers: { "x-demo": "1" }, // 用数组 [["x-demo", "1"]] 传入可以保持头的顺序
  json: { hello: "world" }, // 以 application/json 发送
});

console.log(res.status, res.ok, res.httpVersion); // 200 true 2.0
console.log(await res.json()); // text()、bytes()、blob()、arrayBuffer() 和 body 也都可以用
```

`get`、`post`、`put`、`patch`、`delete`、`head` 和 `options` 在 Client 和 Session 上都有。

### Cookie

每个会话都有自己独立的 Cookie 存储，格式与 Playwright 和 Puppeteer 一致。

```ts
import { Client } from "lkrequest";

const session = new Client().session({ baseUrl: "https://httpbin.org" });

// 服务器设置的 Cookie 会被保存，并随匹配的 URL 发回去。
await session.get("/cookies/set", { params: { theme: "dark" } });
console.log(session.cookies.getAll()); // [{ name: "theme", value: "dark", domain: "httpbin.org", ... }]

// 也可以自己添加，或者只为单个请求附带一个。
session.cookies.set("https://httpbin.org", { name: "token", value: "abc", httpOnly: true });
await session.get("/cookies", { cookies: { extra: "1" } });
```

### 代理

代理就是一个 URL。`http://` 用 CONNECT 建立隧道，`socks5://` 在本地解析目标域名，`socks5h://` 则交给代理解析。下面的地址只是占位，请换成你自己的代理。

```ts
import { Client, ProxyConfig, SessionPool } from "lkrequest";

const client = new Client({ preset: "chrome_155" });

// 会话里的每个请求都走这个代理。
const session = client.session({ proxy: "socks5h://127.0.0.1:1080" });
const res = await session.get("https://httpbin.org/ip");
console.log(await res.json()); // 代理的出口地址，不是你自己的

// 凭据放在 ProxyConfig 上（也可以写进 URL）。代理链会依次经过每一跳。
const withLogin = ProxyConfig.parse("http://127.0.0.1:8080").withUserPass("user", "pass");
const chain = ProxyConfig.chain(["http://127.0.0.1:8080", "socks5://127.0.0.1:1080"]);
await client.session({ proxy: withLogin }).get("https://httpbin.org/ip");
await client.session({ proxy: chain }).get("https://httpbin.org/ip");

// 单个请求可以使用与会话不同的代理。
await session.get("https://httpbin.org/ip", { proxy: "http://127.0.0.1:8081" });

// 会话池租出会话，每个会话绑定池中的一个代理。
const pool = new SessionPool(client, {
  proxies: ["http://127.0.0.1:8081", "http://127.0.0.1:8082"],
});
const lease = await pool.acquire();
try {
  console.log((await lease.session.get("https://httpbin.org/ip")).status);
} finally {
  lease.release(); // 一定要把会话还回去
}
```

如果请求因为代理而失败，请在释放租约之前调用 `lease.markBad()`：该会话会被丢弃，这次失败会记到对应的代理名下。租约也支持 `using`，前提是你的工具链支持。`ProxyConfig#healthCheck()` 会打开一条隧道并返回耗时，`ProxyPool` 租出的是单独的代理，`masque://` 代理通过 CONNECT-UDP 承载 HTTP/3（实验性）。参见 [`proxies.ts`](examples/proxies.ts)、[`proxy-pool.ts`](examples/proxy-pool.ts) 和 [`session-pool.ts`](examples/session-pool.ts)。

### WebSocket

通过会话打开的 WebSocket 沿用会话的指纹、Cookie 和代理。

```ts
import { Client } from "lkrequest";

const session = new Client({ preset: "chrome_155" }).session();
const ws = await session.websocket("wss://echo.websocket.org");

await ws.send("hello"); // 字符串作为文本消息发送，字节作为二进制消息发送

// 迭代会依次得到每条消息，收到对端的 close 消息后结束。
for await (const message of ws) {
  if (message.type === "text") {
    console.log("received:", message.data);
    if (message.data === "hello") break; // echo 服务器会先发一条问候
  }
}

await ws.close();
```

也可以用 `ws.receive()` 逐条接收，用 `ws.ping()` 发送 ping。

### 流式传输

`session.stream()` 在响应头到达后就会返回，响应体在你读取时才从网络拉取。请求体也可以是流，只会按连接能发送的速度被拉取。

```ts
import { createReadStream } from "node:fs";
import { Client } from "lkrequest";

const session = new Client().session();

// 下载：大文件不会整个留在内存里。
const download = await session.stream("https://httpbin.org/stream-bytes/102400");
let size = 0;
for await (const chunk of download.body) size += chunk.byteLength;
console.log(size, "bytes");

// 上传：任何 Readable、ReadableStream 或异步可迭代对象都可以（这里换成你自己的文件）。
await session.put("https://httpbin.org/put", { body: createReadStream("./big.bin") });

// multipart 表单就是标准的 FormData，分隔符与 Chrome 一致。
const form = new FormData();
form.append("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
await session.post("https://httpbin.org/post", { body: form });
```

### HTTP/3

Chrome 预设带有 QUIC 参数。`preferredHttpVersion` 决定会话（或单个请求）使用的协议：`"auto"`、`"http1_only"`、`"http2_only"`、`"http3_only"` 或 `"http3_with_fallback"`。

```ts
import { Client } from "lkrequest";

const client = new Client({ preset: "chrome_155" });
const session = client.session({ preferredHttpVersion: "http3_only" });

const res = await session.get("https://www.cloudflare.com/cdn-cgi/trace");
console.log(res.httpVersion); // 3.0
```

需要更细的控制时，例如让 TCP 与 QUIC 竞速，或者决定 HTTP/3 失败后能否回退，可以从协议策略出发，只改你关心的部分：`client.session({ protocolPolicy: { preset: "chrome_standard", fallback: "no_fallback" } })`。

### 重试、超时与重定向

为请求的每个阶段设置时限，重试失败的请求以及返回 429、503 等状态的响应，并决定如何处理重定向。

```ts
import { Client } from "lkrequest";

const client = new Client({
  // 各阶段的时间限制，单位毫秒。total 覆盖整个请求，包括重定向。
  timeouts: { tcpConnect: 5_000, tlsHandshake: 5_000, ttfb: 10_000, total: 30_000 },
});

const session = client.session({
  retry: { strategy: "exponential", maxRetries: 3, baseDelay: 200 }, // 也可以是 "fixed" 或一个函数
  redirect: "follow", // "manual" 返回重定向响应本身，"error" 拒绝跟随任何重定向
  maxRedirects: 5,
});

console.log((await session.get("https://httpbin.org/redirect/2")).url);
```

重试函数会收到 `{ attempt, status, error }`，返回下一次尝试前要等待的毫秒数，返回 `null` 表示停止。不适合重复发送的请求，例如服务器可能已经处理过的 POST 或流式请求体，无论函数返回什么都不会重试。

### Middleware 与钩子

Middleware 在请求发出前、响应返回后修改它们；钩子只负责观察。

```ts
import { Client, type Middleware } from "lkrequest";

const auth: Middleware = {
  name: "auth",
  onRequest(request) {
    request.headers.push(["authorization", "Bearer my-token"]);
  },
};

// 客户端的 middleware 对它的所有会话生效。
const client = new Client({ middleware: [auth] });

const session = client.session({
  onResponse: (event) => console.log(event.status, `${Math.round(event.elapsed)} ms`),
});
const res = await session.get("https://httpbin.org/bearer");
console.log(await res.json()); // { authenticated: true, token: "my-token" }
```

### 错误处理

请求失败时会抛出 `RequestError` 的子类；响应带错误状态码则不会抛出，请检查 `res.ok`，或调用 `res.throwForStatus()`。

```ts
import { Client, HttpStatusError, RequestError, TimeoutError } from "lkrequest";

const client = new Client();

try {
  const res = await client.get("https://httpbin.org/delay/5", { timeout: 1_000 });
  res.throwForStatus();
} catch (error) {
  if (error instanceof TimeoutError) {
    console.log(error.code, error.retryable); // ERR_LK_TIMEOUT true
  } else if (error instanceof HttpStatusError) {
    console.log(error.status);
  } else if (error instanceof RequestError) {
    console.log(error.code, error.message);
  } else {
    throw error;
  }
}
```

`AbortSignal` 的用法与 `fetch` 一致：`client.get(url, { signal: AbortSignal.timeout(5_000) })`。

### DNS、TLS 与 HSTS

决定域名如何解析、使用哪个地址族，以及如何处理明文的 `http://` URL。

```ts
import { Client, Hsts } from "lkrequest";

const client = new Client({
  dns: "cloudflare", // 也可以是 { server: "1.1.1.1" }、"google_https"（DNS over HTTPS）或 { resolve }
  family: 4, // 只用 IPv4 连接；6 表示只用 IPv6，0 表示不限
});

// 像浏览器遵循 HSTS 那样把 http:// 升级成 https://，并彻底拒绝明文 http://。
const session = client.session({ hsts: Hsts.dynamic(["httpbin.org"]), httpsOnly: true });
const res = await session.get("http://httpbin.org/get");
console.log(res.url); // https://httpbin.org/get
```

`Client` 的其他选项也是同样的用法。`connectTo` 为某个主机固定拨号地址，TLS 的 server name、`Host` 头和证书校验仍然使用原来的名字。`tls: { ca }` 信任私有证书颁发机构，`tls: { rejectUnauthorized: false }` 关闭证书校验（仅用于测试），`tls: { keylog: "./keys.log" }` 以 NSS key log 格式写出 TLS 密钥，供 Wireshark 使用。

### 自定义指纹

每一层都可以来自预设、JSON、抓包数据或你自己的取值。可以自由搭配，再检查它们是否仍然协调。

```ts
import {
  Client,
  H2Profile,
  TcpFingerprint,
  TlsProfile,
  validateFingerprintConsistency,
} from "lkrequest";

const client = new Client({
  tlsProfile: TlsProfile.preset("chrome_155"), // 或 fromJSON()、fromClientHello(bytes)、create()
  h2Profile: H2Profile.preset("chrome_155"), // 或 fromJSON()、fromH2Frames(bytes)、create()
  tcpFingerprint: TcpFingerprint.fromJa4t("64240_2-1-3-1-1-4_1460_8"), // 或 create()
});
console.log(client.fingerprintInfo());

// Chrome 的握手搭配 Firefox 的 HTTP/2 设置，很容易被识破。
const check = validateFingerprintConsistency({
  tlsProfile: "chrome_155",
  h2Profile: "firefox_156",
});
console.log(check.valid, check.warnings); // false [ "TLS profile family 'chrome' does not match ..." ]
```

选项 `randomize: "extension_order"` 会让 TLS 扩展顺序在每个连接上随机变化：JA3 会变，JA4 不变，客户端仍然像一个真实的浏览器。Chrome 预设本来就会这样随机，和 Chrome 一样；Firefox 预设不会，所以这个选项对它们才有用。`"recombine"` 和 `"full"` 两种模式（写作 `randomize: { mode: "recombine" }`）更进一步，会合成一个不对应任何真实浏览器的指纹，用于封锁已知指纹的目标。

### 可观测性

四种了解客户端行为的方式：日志事件、追踪事件、计数器，以及每个响应的分阶段耗时。

```ts
import { subscribe } from "node:diagnostics_channel";
import { Client, enableMetrics, onLog, type RequestEndMessage, setLogLevel } from "lkrequest";

// Rust 库的日志事件，过滤语法与 tracing 一致。
setLogLevel("lkrequest=debug");
onLog((record) => console.log(`[${record.level}] ${record.message}`));

// 给 APM 工具用的追踪事件：lkrequest:request:start、:end 和 :error。
subscribe("lkrequest:request:end", (message) => {
  const { request, response } = message as RequestEndMessage;
  console.log(request.method, request.url, response.status);
});

// 按 host 统计的计数器，也可以输出成 Prometheus 文本。
const metrics = enableMetrics();

const res = await new Client().get("https://httpbin.org/get");

// 每个响应都会说明各阶段花了多久；没有发生的阶段不会出现。
console.log(res.diagnostics); // { dnsMs, tcpMs, tlsMs, ttfbMs, totalMs, remoteAddr, protocol, ... }
console.log(metrics.prometheusText());
```

`pendingRequests()` 返回在途请求数，`await drainPending({ timeout })` 会等待它们结束，例如在进程退出前的 SIGTERM 处理函数里使用。

## 工作原理

```text
你的代码
   │  Client · Session · Response · ...
   ▼
lkrequest（本包）：类 fetch 的 TypeScript API
   │  Node-API（通过 napi-rs），每个平台一个预编译扩展
   ▼
原生扩展（Rust）
   │
   ▼
lkrequest-rs：TLS · HTTP/2 · HTTP/3 与 QUIC · 代理 · DNS · Cookie
```

请求运行在 Rust 的异步运行时上，不会阻塞 Node.js 的事件循环，响应的字节也不经拷贝就交给 JavaScript。线路上发出的内容由 Rust 库决定，所以新的浏览器预设先出现在那里，再随下一个版本进入本包。

## 注意事项

- **预设只设置指纹，不设置请求头的取值。** `User-Agent`、`Accept-Language` 等浏览器会发的头要自己设置，并与预设保持一致。
- **只有 Chrome 预设支持 HTTP/3。** Firefox 和 Safari 预设不带 QUIC 参数，只走 TCP。
- **你传入的函数运行在主线程上。** DNS 解析函数、代理函数、自定义代理凭据、自定义 HSTS 策略和 middleware 在请求等待它们时都在主线程上执行，要尽量快。每个会话现编一个代理时，`proxyBuffer` 可以提前准备几个。
- **池会等到有可用的代理。** 池里的代理全部因失败而冷却，或者代理函数一直失败时，`acquire()` 会一直等待，而不是交出直连的会话。要中途放弃，传入 `signal`。
- **MASQUE 是实验性的。** 它的 API 和行为可能在任何版本中变化。

## 开发

从源码构建需要 Rust（stable）、Node.js 22.12 或更高版本、pnpm（通过 corepack）、CMake 和 NASM。测试还需要 [uv](https://docs.astral.sh/uv/)，用它运行本地的测试服务。

```bash
pnpm install
pnpm build:native:debug   # 构建原生扩展：全部 feature，debug 模式
pnpm test                 # vitest
pnpm typecheck            # tsc --noEmit
pnpm lint                 # Biome + rustfmt + clippy
pnpm build                # release 原生扩展 + dist/
```

## 参与贡献

欢迎贡献。目录结构、代码风格和提交 PR 前的检查清单见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。客户端在网络上发出的内容由 [Rust 库](https://github.com/EZXLabs/lkrequest-rs)决定，指纹方面的改动应当提给它。

## 安全

请按 [SECURITY.md](SECURITY.md)（英文）的说明私下报告漏洞，同一份文件也说明了本项目的适用范围。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
