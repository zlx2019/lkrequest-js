// Cookies
//
// A session stores the cookies a server sets and sends them back to matching URLs. The jar is
// `session.cookies`, in the cookie format Playwright and Puppeteer use.
//
// Run: node examples/cookies.ts (see examples/README.md)

import { Client } from "lkrequest";

const session = new Client().session({ baseUrl: "https://httpbin.org" });

// The server sets two cookies, then redirects to /cookies, which lists the cookies it got.
await session.get("/cookies/set", { params: { theme: "dark", lang: "en" } });

// The jar holds them now.
for (const cookie of session.cookies.getAll()) {
  console.log(cookie.name, cookie.value, cookie.domain, cookie.path);
}

// Later requests send them back by themselves.
const echoed = await session.get("/cookies");
console.log(await echoed.json()); // { cookies: { lang: 'en', theme: 'dark' } }

// Store a cookie yourself, as if the server at this URL had set it.
session.cookies.set("https://httpbin.org", { name: "token", value: "abc", httpOnly: true });
console.log(session.cookies.get("https://httpbin.org", "token")?.value);

// Cookies for one request only. They are sent, but not stored.
const once = await session.get("/cookies", { cookies: { extra: "1" } });
console.log(await once.json());

// Remove one cookie, or all of them.
session.cookies.delete("https://httpbin.org", "theme");
session.cookies.clear();
console.log(session.cookies.getAll().length); // 0
