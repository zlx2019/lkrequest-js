/** `JSON.rawJSON()` (Node 21 and later), which the es2023 lib of TypeScript does not declare. */
const { rawJSON } = JSON as JSON & { rawJSON(text: string): unknown };

/**
 * Parses JSON from the native layer without rounding integers beyond 2^53, which upstream's
 * formats can hold (QUIC varints). Those stay exact as `JSON.rawJSON()` values, which
 * `JSON.stringify` writes back unchanged, so the object survives a round trip.
 */
export function parseExactJson(text: string): Record<string, unknown> {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    const source = context?.source;
    if (typeof value === "number" && !Number.isSafeInteger(value) && source !== undefined) {
      return /^-?\d+$/.test(source) ? rawJSON(source) : value;
    }
    return value;
  }) as Record<string, unknown>;
}
