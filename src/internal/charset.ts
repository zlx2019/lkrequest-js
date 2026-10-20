import { TextDecoder } from "node:util";

/**
 * Response text decoding, with the rules of lkrequest-py and of browsers (WHATWG Encoding):
 * a byte order mark wins over the declared charset, an unknown declared charset falls back
 * to UTF-8, and malformed bytes become U+FFFD rather than an error.
 */

/** The `charset` parameter of a `Content-Type` value, if present. */
export function declaredCharset(contentType: string | null): string | undefined {
  if (contentType === null) {
    return undefined;
  }
  for (const part of contentType.split(";").slice(1)) {
    const [name, value] = part.split("=", 2);
    if (name?.trim().toLowerCase() === "charset" && value !== undefined) {
      return value.trim().replace(/^"(.*)"$/, "$1");
    }
  }
  return undefined;
}

/**
 * Decodes a body. `encoding`, when given, is a WHATWG label chosen by the caller and must be
 * valid (`TextDecoder` throws `RangeError` otherwise); without it the body's BOM, then the
 * declared charset, then UTF-8 decide.
 */
export function decodeText(
  bytes: Uint8Array,
  contentType: string | null,
  encoding?: string,
): string {
  if (encoding !== undefined) {
    return new TextDecoder(encoding).decode(bytes);
  }
  return decoderFor(sniffBom(bytes) ?? declaredCharset(contentType)).decode(bytes);
}

/** The encoding a byte order mark announces, if the body starts with one. */
function sniffBom(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  return undefined;
}

/** A decoder for a label taken from the response, falling back to UTF-8 when unknown. */
function decoderFor(label: string | undefined): TextDecoder {
  if (label !== undefined) {
    try {
      return new TextDecoder(label);
    } catch {
      // A label the server made up is remote data, not a caller mistake.
    }
  }
  return new TextDecoder("utf-8");
}
