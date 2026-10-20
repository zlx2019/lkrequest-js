import type { HeadersInput, PairsInput } from "../types.js";

/**
 * Flattens headers into `[name, value, name, value, ...]`, the shape the native layer takes.
 * Pairs keep their order; a `Headers` instance yields its own (sorted) order.
 */
export function flattenHeaders(init: HeadersInput): string[] {
  return flattenPairs(init instanceof Headers ? init.entries() : init);
}

/** Flattens a record or an iterable of name/value pairs. */
export function flattenPairs(init: PairsInput): string[] {
  const entries = isIterable(init) ? init : Object.entries(init);
  const flat: string[] = [];
  for (const [name, value] of entries) {
    flat.push(String(name), String(value));
  }
  return flat;
}

/** Turns flat pairs back into tuples. */
export function unflatten(flat: readonly string[]): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i] as string, flat[i + 1] as string]);
  }
  return pairs;
}

/** Builds a WHATWG `Headers` from flat pairs, appending duplicates. */
export function headersFromFlat(flat: readonly string[]): Headers {
  const headers = new Headers();
  for (const [name, value] of unflatten(flat)) {
    headers.append(name, value);
  }
  return headers;
}

/** Whether a header with this name (case-insensitively) is among the flat pairs. */
export function hasHeader(flat: readonly string[], name: string): boolean {
  const wanted = name.toLowerCase();
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i]?.toLowerCase() === wanted) {
      return true;
    }
  }
  return false;
}

/** Whether a value can be iterated with `for...of`. */
function isIterable<T>(value: object): value is Iterable<T> {
  return Symbol.iterator in value;
}
