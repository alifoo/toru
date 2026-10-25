import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { isPublicNetworkAddress } from "@content-layer/browser";
import { connect as netConnect, type Socket } from "node:net";

const MAX_HEADERS = 100;
const MAX_HEADER_SIZE = 16 * 1024;
const SOCKET_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 5_000;

type LookupAddress = { address: string; family: 4 | 6 };
type Lookup = (hostname: string) => Promise<readonly LookupAddress[]>;
type Connect = (address: string, port: number) => Socket;

class PinnedAgent extends Agent {
  constructor(private readonly open: Connect, private readonly address: string) {
    super({ keepAlive: false });
  }

  override createConnection(): Socket {
    return this.open(this.address, 80);
  }
}

export type EgressProxyOptions = {
  lookup?: Lookup;
  connect?: Connect;
  /** The hosted worker binds on its private Docker network; local mode stays loopback-only. */
  bindAddress?: string;
  port?: number;
};

export type EgressProxy = {
  port: number;
  close: () => Promise<void>;
};

const forbiddenHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
]);

function publicLookup(): Lookup {
  return async (hostname) => {
    const result = await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS).unref(),
      ),
    ]);
    return result.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  };
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "");
}

function statusLine(socket: Socket, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
}

function rejectRequest(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { connection: "close", "content-type": "text/plain" });
  response.end(text);
}

async function resolvePublicAddress(hostname: string, lookup: Lookup): Promise<LookupAddress> {
  const address = stripBrackets(hostname);
  if (isIP(address)) {
    if (!isPublicNetworkAddress(address)) throw new Error("private destination");
    return { address, family: isIP(address) as 4 | 6 };
  }

  const addresses = await lookup(address);
  if (addresses.length === 0 || addresses.some(({ address: candidate }) => !isPublicNetworkAddress(candidate))) {
    throw new Error("private destination");
  }
  const selected = addresses[0];
  if (!selected) throw new Error("no destination");
  return selected;
}

function parseHttpTarget(rawUrl: string): URL {
  const target = new URL(rawUrl);
  if (target.protocol !== "http:" || target.username || target.password || target.port !== "") {
    throw new Error("unsupported target");
  }
  if (!target.hostname) throw new Error("missing host");
  return target;
}

function parseConnectTarget(rawTarget: string): { hostname: string; port: number } {
  const target = new URL(`http://${rawTarget}`);
  if (
    !target.hostname ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash ||
    target.port !== "443"
  ) {
    throw new Error("unsupported target");
  }
  return { hostname: target.hostname, port: 443 };
}

function outgoingHeaders(request: IncomingMessage, host: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !forbiddenHeaders.has(name)) headers[name] = value;
  }
  headers.host = host;
  return headers;
}

function tunnel(client: Socket, upstream: Socket, head: Buffer): void {
  client.write("HTTP/1.1 200 Connection Established\r\nConnection: close\r\n\r\n");
  if (head.length > 0) upstream.write(head);
  client.pipe(upstream);
  upstream.pipe(client);
  client.once("error", () => upstream.destroy());
  upstream.once("error", () => client.destroy());
}

async function handleConnect(
  request: IncomingMessage,
  client: Socket,
  head: Buffer,
  lookup: Lookup,
  connect: Connect,
): Promise<void> {
  try {
    const { hostname, port } = parseConnectTarget(request.url ?? "");
    const resolved = await resolvePublicAddress(hostname, lookup);
    const upstream = connect(resolved.address, port);
    upstream.setTimeout(SOCKET_TIMEOUT_MS, () => upstream.destroy());
    upstream.once("connect", () => tunnel(client, upstream, head));
    upstream.once("error", () => {
      if (!client.destroyed) statusLine(client, 502, "Bad Gateway");
    });
  } catch {
    statusLine(client, 403, "Forbidden");
  }
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  lookup: Lookup,
  connect: Connect,
): Promise<void> {
  let target: URL;
  try {
    target = parseHttpTarget(request.url ?? "");
  } catch {
    rejectRequest(response, 403, "Forbidden");
    return;
  }

  let resolved: LookupAddress;
  try {
    resolved = await resolvePublicAddress(target.hostname, lookup);
  } catch {
    rejectRequest(response, 403, "Forbidden");
    return;
  }

  const agent = new PinnedAgent(connect, resolved.address);
  const upstream = httpRequest({
    method: request.method,
    host: resolved.address,
    port: 80,
    path: `${target.pathname}${target.search}`,
    headers: outgoingHeaders(request, target.host),
    agent,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(SOCKET_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")));
  upstream.once("error", () => {
    if (!response.headersSent) rejectRequest(response, 502, "Bad Gateway");
    else response.destroy();
  });
  request.once("aborted", () => upstream.destroy());
  request.once("error", () => upstream.destroy());
  request.pipe(upstream);
}

/** A loopback-only forward proxy for browser egress. Every hostname is resolved and pinned. */
export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const bindAddress = options.bindAddress ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_egress_proxy_port");
  const lookup = options.lookup ?? publicLookup();
  const connect = options.connect ?? ((address, port) => netConnect({ host: address, port }));
  const server = createServer(
    { maxHeaderSize: MAX_HEADER_SIZE },
    (request, response) => void handleHttp(request, response, lookup, connect),
  );
  server.maxHeadersCount = MAX_HEADERS;
  server.headersTimeout = 10_000;
  server.requestTimeout = SOCKET_TIMEOUT_MS;
  server.timeout = SOCKET_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  server.on("connect", (request, socket, head) => {
    const client = socket as Socket;
    client.setTimeout(SOCKET_TIMEOUT_MS, () => client.destroy());
    void handleConnect(request, client, head, lookup, connect);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindAddress, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("egress proxy did not bind");
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
