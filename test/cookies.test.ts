import { describe, expect, it } from "vitest";
import { serverUrl, testClient } from "./support/clients.js";

/** Cookies httpbin's `/cookies` saw on the request. */
async function sentCookies(session: ReturnType<ReturnType<typeof testClient>["session"]>) {
  const res = await session.get(serverUrl("/cookies"));
  return (await res.json<{ cookies: Record<string, string> }>()).cookies;
}

describe("CookieJar", () => {
  it("stores cookies the server sets and sends them back", async () => {
    const session = testClient().session();
    await session.get(serverUrl("/cookies/set?a=1&b=2"));
    await expect(sentCookies(session)).resolves.toEqual({ a: "1", b: "2" });
    expect(session.cookies.header(serverUrl("/"))).toBe("a=1; b=2");
  });

  it("lists cookies in the Playwright format", async () => {
    const session = testClient().session();
    await session.get(serverUrl("/cookies/set?a=1"));
    const [cookie] = session.cookies.getAll(serverUrl("/"));
    expect(cookie).toEqual({
      name: "a",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      expires: -1,
      httpOnly: false,
      // httpbin marks cookies it sets over HTTPS as Secure.
      secure: true,
    });
    expect(session.cookies.getAll()).toHaveLength(1);
    expect(session.cookies.get(serverUrl("/"), "a")?.value).toBe("1");
    expect(session.cookies.get(serverUrl("/"), "missing")).toBeUndefined();
  });

  it("sets cookies with every attribute and round-trips them", async () => {
    const session = testClient().session();
    const expires = Math.floor(Date.now() / 1000) + 3600;
    session.cookies.set(serverUrl("/"), {
      name: "token",
      value: "abc",
      path: "/",
      expires,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
    const cookie = session.cookies.get(serverUrl("/"), "token");
    expect(cookie).toEqual({
      name: "token",
      value: "abc",
      domain: "127.0.0.1",
      path: "/",
      expires,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
    await expect(sentCookies(session)).resolves.toEqual({ token: "abc" });

    const copy = testClient().session();
    copy.cookies.set(serverUrl("/"), cookie as NonNullable<typeof cookie>);
    expect(copy.cookies.getAll()).toEqual(session.cookies.getAll());
  });

  it("keeps cookies of the same name on different paths apart", () => {
    const session = testClient().session();
    session.cookies.set(serverUrl("/"), { name: "token", value: "root", path: "/" });
    session.cookies.set(serverUrl("/api/"), { name: "token", value: "api", path: "/api" });
    expect(session.cookies.getValues(serverUrl("/api/users"), "token").sort()).toEqual([
      "api",
      "root",
    ]);
    expect(session.cookies.getValues(serverUrl("/other"), "token")).toEqual(["root"]);
  });

  it("stores a raw Set-Cookie header", () => {
    const session = testClient().session();
    session.cookies.setRaw(serverUrl("/"), "raw=1; Path=/; HttpOnly");
    expect(session.cookies.get(serverUrl("/"), "raw")).toMatchObject({
      value: "1",
      httpOnly: true,
    });
  });

  it("deletes one cookie or clears them all", () => {
    const session = testClient().session();
    session.cookies.set(serverUrl("/"), { name: "a", value: "1" });
    session.cookies.set(serverUrl("/"), { name: "b", value: "2" });
    session.cookies.delete(serverUrl("/"), "a");
    expect(session.cookies.getAll().map((cookie) => cookie.name)).toEqual(["b"]);
    session.cookies.clear();
    expect(session.cookies.getAll()).toEqual([]);
    expect(session.cookies.header(serverUrl("/"))).toBeUndefined();
  });

  it("keeps jars of different sessions apart", async () => {
    const client = testClient();
    const first = client.session();
    await first.get(serverUrl("/cookies/set?only=first"));
    await expect(sentCookies(client.session())).resolves.toEqual({});
  });

  it.each([
    ["__Secure-ok=1; Secure", true],
    ["__Secure-bad=1", false],
    ["__Host-ok=1; Secure; Path=/", true],
    ["__Host-nosecure=1; Path=/", false],
    ["__Host-domain=1; Secure; Path=/; Domain=example.com", false],
    ["__Host-subpath=1; Secure; Path=/sub", false],
  ])("enforces the cookie name prefix of %s", (header, accepted) => {
    const { cookies } = testClient().session();
    cookies.setRaw("https://example.com/", "control=1");
    cookies.setRaw("https://example.com/", header);
    const names = cookies.getAll("https://example.com/").map((cookie) => cookie.name);
    expect(names).toContain("control");
    expect(names.includes(header.split("=")[0] ?? "")).toBe(accepted);
  });

  it("ignores Secure cookies over plain HTTP and does not send them there", () => {
    const { cookies } = testClient().session();
    cookies.setRaw("http://example.com/", "plain=1");
    cookies.setRaw("http://example.com/", "over-http=1; Secure");
    expect(cookies.getAll("http://example.com/").map((cookie) => cookie.name)).toEqual(["plain"]);

    cookies.setRaw("https://example.com/", "s=1; Secure");
    expect(cookies.getValues("https://example.com/", "s")).toEqual(["1"]);
    expect(cookies.getValues("http://example.com/", "s")).toEqual([]);
  });

  it("rejects an invalid URL or a cookie that would break the header", () => {
    const { cookies } = testClient().session();
    expect(() => cookies.getAll("not a url")).toThrow(TypeError);
    expect(() => cookies.set(serverUrl("/"), { name: "a;b", value: "1" })).toThrow(TypeError);
    expect(() => cookies.set(serverUrl("/"), { name: "a", value: "1\r\nx: y" })).toThrow(TypeError);
  });
});

describe("an empty Max-Age", () => {
  const url = "https://example.com/";

  it("counts as absent, so the cookie lasts for the session", () => {
    const { cookies } = testClient().session();
    cookies.setRaw(url, "sid=1; Path=/; Max-Age=");
    expect(cookies.get(url, "sid")).toMatchObject({ value: "1", expires: -1 });
  });

  it("does not outrank Expires, so a past one deletes the cookie", () => {
    const { cookies } = testClient().session();
    cookies.setRaw(url, "sid=old; Path=/; Max-Age=3600");
    cookies.setRaw(url, "sid=new; Path=/; Max-Age=; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(cookies.get(url, "sid")).toBeUndefined();
  });

  it("leaves a valid Max-Age before it in charge", () => {
    const { cookies } = testClient().session();
    const now = Date.now() / 1000;
    cookies.setRaw(url, "sid=1; Path=/; Max-Age=60; Max-Age=");
    const expires = cookies.get(url, "sid")?.expires ?? 0;
    expect(expires).toBeGreaterThanOrEqual(Math.floor(now) + 60);
    expect(expires).toBeLessThanOrEqual(Math.ceil(now) + 61);
  });

  it("is read the same way in the Set-Cookie headers of a response", async () => {
    const session = testClient().session();
    session.cookies.setRaw(serverUrl("/"), "gone=1; Path=/");
    const query = new URLSearchParams([
      ["Set-Cookie", "kept=1; Path=/; Max-Age="],
      ["Set-Cookie", "gone=; Path=/; Max-Age=; Expires=Thu, 01 Jan 1970 00:00:00 GMT"],
    ]);
    await session.get(serverUrl(`/response-headers?${query}`));
    const cookies = session.cookies.getAll(serverUrl("/"));
    expect(cookies.map(({ name, expires }) => [name, expires])).toEqual([["kept", -1]]);
  });
});
