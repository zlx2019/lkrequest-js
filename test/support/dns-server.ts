import { createSocket } from "node:dgram";
import { once } from "node:events";

/**
 * The domain the tests resolve with a DNS server of their own; the test server's certificate
 * covers every name under it (see `make_self_signed_cert` in `server.py`).
 */
export const TEST_DOMAIN = "lkrequest.test";

/** One question the server was asked. */
export interface DnsQuery {
  /** The queried name, lower-cased, without the trailing dot. */
  readonly name: string;
  /** The record type: 1 is A, 28 is AAAA, 65 is HTTPS. */
  readonly type: number;
}

/** A DNS server for tests, listening on the loopback interface over UDP. */
export interface TestDnsServer {
  /** The server as `ip:port`. */
  readonly address: string;
  /** Every question received so far, in arrival order. */
  readonly queries: readonly DnsQuery[];
  /** Stops the server. */
  close(): Promise<void>;
}

/** Record types the server answers. */
const TYPE_A = 1;
const TYPE_HTTPS = 65;

/** The size of the DNS message header. */
const HEADER_SIZE = 12;

/**
 * Starts a DNS server that answers A queries for the names in `hosts` (each mapped to one
 * IPv4 address) and says "no such record" to every other type, such as AAAA. A name outside
 * `hosts` does not exist. The names in `h3` also have an HTTPS record that advertises HTTP/3.
 */
export async function startDnsServer(
  hosts: Readonly<Record<string, string>>,
  h3: readonly string[] = [],
): Promise<TestDnsServer> {
  const table = new Map(Object.entries(hosts).map(([name, ip]) => [name.toLowerCase(), ip]));
  const advertisingH3 = new Set(h3.map((name) => name.toLowerCase()));
  const queries: DnsQuery[] = [];
  const socket = createSocket("udp4");
  socket.on("message", (message, remote) => {
    const question = parseQuestion(message);
    if (question === undefined) return;
    const { name, type } = question.query;
    queries.push(question.query);
    const ip = table.get(name);
    let answer: Buffer = Buffer.alloc(0);
    if (type === TYPE_A && ip !== undefined) answer = buildARecord(ip);
    if (type === TYPE_HTTPS && advertisingH3.has(name)) answer = buildH3Record();
    const response = buildResponse(message, question.end, table.has(name), answer);
    socket.send(response, remote.port, remote.address);
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  return {
    address: `127.0.0.1:${port}`,
    queries,
    close: async () => {
      socket.close();
      await once(socket, "close");
    },
  };
}

/** Reads the first question of a query: its name, type, and the offset where it ends. */
function parseQuestion(message: Buffer): { query: DnsQuery; end: number } | undefined {
  const labels: string[] = [];
  let offset = HEADER_SIZE;
  for (;;) {
    const length = message[offset];
    if (length === undefined) return undefined;
    offset += 1;
    if (length === 0) break;
    // Queries carry no compression pointers, whose two top bits would be set.
    if (length > 63) return undefined;
    labels.push(message.toString("ascii", offset, offset + length));
    offset += length;
  }
  if (offset + 4 > message.length) return undefined;
  const type = message.readUInt16BE(offset);
  return { query: { name: labels.join(".").toLowerCase(), type }, end: offset + 4 };
}

/**
 * Builds the response to `query`: its question echoed back, then the `answer` record, if any
 * (at most one). A name outside the table answers NXDOMAIN, a known name without a matching
 * record answers NOERROR with no records.
 */
function buildResponse(
  query: Buffer,
  questionEnd: number,
  exists: boolean,
  answer: Buffer,
): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  const recursionDesired = query.readUInt16BE(2) & 0x0100;
  const responseCode = exists ? 0 : 3;
  // Response flag, the query's recursion-desired bit, recursion available, and the code.
  header.writeUInt16BE(0x8000 | recursionDesired | 0x0080 | responseCode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answer.length === 0 ? 0 : 1, 6);
  return Buffer.concat([header, query.subarray(HEADER_SIZE, questionEnd), answer]);
}

/** An A record for the question at offset 12 (a name pointer), valid for a minute. */
function buildARecord(ip: string): Buffer {
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(TYPE_A, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(60, 6);
  record.writeUInt16BE(4, 10);
  Buffer.from(ip.split(".").map(Number)).copy(record, 12);
  return record;
}

/** An HTTPS record for the question at offset 12: service mode, ALPN `h3`, valid for a minute. */
function buildH3Record(): Buffer {
  // Priority 1, the owner itself as target, one parameter: key 1 (alpn) holding "h3".
  const data = Buffer.from([0, 1, 0, 0, 1, 0, 3, 2, 0x68, 0x33]);
  const record = Buffer.alloc(12 + data.length);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(TYPE_HTTPS, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(60, 6);
  record.writeUInt16BE(data.length, 10);
  data.copy(record, 12);
  return record;
}
