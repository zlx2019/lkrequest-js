import type { NativeCookie, NativeSession } from "../native/index.cjs";

/** `SameSite` attribute of a cookie. */
export type SameSite = "Strict" | "Lax" | "None";

/**
 * A stored cookie, in the format Playwright and Puppeteer use, so cookies move between
 * lkrequest and browser automation without conversion.
 */
export interface Cookie {
  /** Cookie name. */
  readonly name: string;
  /** Cookie value. */
  readonly value: string;
  /**
   * Domain the cookie applies to. A leading dot (`.example.com`) means subdomains match too;
   * without it the cookie is host-only.
   */
  readonly domain: string;
  /** Path the cookie applies to. */
  readonly path: string;
  /** Expiry as Unix seconds, or `-1` for a session cookie. */
  readonly expires: number;
  /** Hidden from scripts. */
  readonly httpOnly: boolean;
  /** Sent over HTTPS only. */
  readonly secure: boolean;
  /** `SameSite` attribute, when the cookie set one. */
  readonly sameSite?: SameSite;
}

/** A cookie to store; everything but the name and value is optional. */
export interface CookieInit {
  /** Cookie name. */
  readonly name: string;
  /** Cookie value. */
  readonly value: string;
  /**
   * Domain the cookie applies to. A leading dot, or a domain other than the URL's own host,
   * makes it a domain cookie; the URL's own host without a dot makes it host-only, matching
   * the format {@link CookieJar#getAll} returns. Defaults to host-only.
   */
  readonly domain?: string;
  /** Path the cookie applies to (defaults to the URL's directory). */
  readonly path?: string;
  /** Expiry as Unix seconds; `-1` or absent for a session cookie. */
  readonly expires?: number;
  /** Hide the cookie from scripts. */
  readonly httpOnly?: boolean;
  /** Send the cookie over HTTPS only. */
  readonly secure?: boolean;
  /** `SameSite` attribute. */
  readonly sameSite?: SameSite;
}

/** Characters that would break a `Set-Cookie` header out of a name or value. */
const FORBIDDEN = /[;\r\n\0]/;

/**
 * The cookies of a session (`session.cookies`). Cookies the server sets are stored
 * automatically and sent with matching requests.
 */
export class CookieJar {
  readonly #native: NativeSession;

  /** Cookie jars belong to a session; they cannot be constructed directly. */
  private constructor(nativeSession: NativeSession) {
    this.#native = nativeSession;
  }

  /** @internal Wraps the jar of a native session. */
  static fromNative(nativeSession: NativeSession): CookieJar {
    return new CookieJar(nativeSession);
  }

  /** The cookie called `name` that would be sent to `url`. */
  get(url: string | URL, name: string): Cookie | undefined {
    return this.getAll(url).find((cookie) => cookie.name === name);
  }

  /** Cookies that would be sent to `url`, in send order; every cookie without a URL. */
  getAll(url?: string | URL): Cookie[] {
    const cookies =
      url === undefined ? this.#native.allCookies() : this.#native.cookiesFor(checkUrl(url));
    return cookies.map(toCookie);
  }

  /** Values of every cookie called `name` that would be sent to `url` (several paths may match). */
  getValues(url: string | URL, name: string): string[] {
    return this.#native.cookieValues(checkUrl(url), name);
  }

  /** The `Cookie` header that would be sent to `url`, if any cookie applies. */
  header(url: string | URL): string | undefined {
    return this.#native.cookieHeader(checkUrl(url)) ?? undefined;
  }

  /** Stores a cookie as if `url` had set it. */
  set(url: string | URL, cookie: CookieInit): void {
    const target = new URL(checkUrl(url));
    this.#native.setCookieRaw(target.href, toSetCookie(cookie, target.hostname));
  }

  /** Stores a cookie from a raw `Set-Cookie` header value, as if `url` had sent it. */
  setRaw(url: string | URL, setCookie: string): void {
    this.#native.setCookieRaw(checkUrl(url), setCookie);
  }

  /** Removes the cookie called `name` that applies to `url`. */
  delete(url: string | URL, name: string): void {
    this.#native.removeCookie(checkUrl(url), name);
  }

  /** Removes every cookie. */
  clear(): void {
    this.#native.clearCookies();
  }
}

/** Validates a URL up front; upstream would silently ignore an invalid one. */
function checkUrl(url: string | URL): string {
  return new URL(url).href;
}

/** Converts a stored cookie to the Playwright format. */
function toCookie(native: NativeCookie): Cookie {
  const domain = native.domain ?? "";
  return {
    name: native.name,
    value: native.value,
    domain: native.hostOnly || domain === "" ? domain : `.${domain}`,
    path: native.path,
    expires: native.expires ?? -1,
    httpOnly: native.httpOnly,
    secure: native.secure,
    ...(native.sameSite != null && { sameSite: native.sameSite as SameSite }),
  };
}

/** Composes the `Set-Cookie` header that stores `cookie` for a URL on `host`. */
function toSetCookie(cookie: CookieInit, host: string): string {
  if (cookie.name === "" || cookie.name.includes("=") || FORBIDDEN.test(cookie.name)) {
    throw new TypeError(`invalid cookie name ${JSON.stringify(cookie.name)}`);
  }
  if (FORBIDDEN.test(cookie.value)) {
    throw new TypeError(`invalid value for cookie ${JSON.stringify(cookie.name)}`);
  }
  const parts = [`${cookie.name}=${cookie.value}`];
  const { domain } = cookie;
  if (domain !== undefined && (domain.startsWith(".") || domain !== host)) {
    parts.push(`Domain=${domain}`);
  }
  if (cookie.path !== undefined) {
    parts.push(`Path=${cookie.path}`);
  }
  if (cookie.expires !== undefined && cookie.expires >= 0) {
    parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
  }
  if (cookie.secure) {
    parts.push("Secure");
  }
  if (cookie.httpOnly) {
    parts.push("HttpOnly");
  }
  if (cookie.sameSite !== undefined) {
    parts.push(`SameSite=${cookie.sameSite}`);
  }
  return parts.join("; ");
}
