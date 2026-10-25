import { connect as tcpConnect, createServer as createTcpServer, type Socket } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { startEgressProxy } from "./egress.js";

async function listen(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createTcpServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

function requestThroughProxy(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: target, method: "GET" },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function waitForData(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once("data", resolve);
    socket.once("error", reject);
  });
}

describe("egress proxy", () => {
  it("forwards HTTP through the pinned resolved address", async () => {
    const destination = createHttpServer((request, response) => {
      expect(request.headers.host).toBe("example.test");
      response.end("ok");
    });
    const destinationPort = await listen(destination);
    const connectCalls: Array<[string, number]> = [];
    const proxy = await startEgressProxy({
      lookup: async (hostname) => {
        expect(hostname).toBe("example.test");
        return [{ address: "93.184.216.34", family: 4 }];
      },
      connect: (address, port) => {
        connectCalls.push([address, port]);
        return tcpConnect(destinationPort, "127.0.0.1");
      },
    });

    try {
      await expect(requestThroughProxy(proxy.port, "http://example.test/demo")).resolves.toEqual({
        status: 200,
        body: "ok",
      });
      expect(connectCalls).toEqual([["93.184.216.34", 80]]);
    } finally {
      await proxy.close();
      destination.close();
    }
  });

  it("streams a POST body to the pinned destination", async () => {
    let received = "";
    const destination = createHttpServer(async (request, response) => {
      for await (const chunk of request) received += chunk.toString();
      response.end("accepted");
    });
    const destinationPort = await listen(destination);
    const proxy = await startEgressProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: () => tcpConnect(destinationPort, "127.0.0.1"),
    });
    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest({ host: "127.0.0.1", port: proxy.port, path: "http://example.test/upload", method: "POST" }, response => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        request.once("error", reject);
        request.end("payload".repeat(1024));
      });
      expect(result).toEqual({ status: 200, body: "accepted" });
      expect(received).toBe("payload".repeat(1024));
    } finally {
      await proxy.close();
      destination.close();
    }
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    let connected = false;
    const proxy = await startEgressProxy({
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
      connect: () => {
        connected = true;
        throw new Error("must not connect");
      },
    });
    try {
      await expect(requestThroughProxy(proxy.port, "http://example.test/")).resolves.toMatchObject({ status: 403 });
      expect(connected).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it("rejects private IP literals before opening a socket", async () => {
    let lookedUp = false;
    const proxy = await startEgressProxy({
      lookup: async () => {
        lookedUp = true;
        return [{ address: "93.184.216.34", family: 4 }];
      },
    });
    try {
      await expect(requestThroughProxy(proxy.port, "http://169.254.169.254/")).resolves.toMatchObject({ status: 403 });
      expect(lookedUp).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it("rejects reserved IPv6 literals before opening a socket", async () => {
    let connected = false;
    const proxy = await startEgressProxy({
      connect: () => { connected = true; throw new Error("must not connect"); },
    });
    try {
      for (const address of ["2001:db8::1", "ff02::1"]) {
        await expect(requestThroughProxy(proxy.port, `http://[${address}]/`)).resolves.toMatchObject({ status: 403 });
      }
      expect(connected).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it("rejects credentials and non-HTTP targets", async () => {
    const proxy = await startEgressProxy({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    try {
      await expect(requestThroughProxy(proxy.port, "http://user:secret@example.test/")).resolves.toMatchObject({ status: 403 });
      await expect(requestThroughProxy(proxy.port, "https://example.test/")).resolves.toMatchObject({ status: 403 });
    } finally {
      await proxy.close();
    }
  });

  it("opens an HTTPS CONNECT tunnel to the pinned address", async () => {
    const destination = createTcpServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
    const destinationPort = await listen(destination);
    const proxy = await startEgressProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: (address, port) => {
        expect(address).toBe("93.184.216.34");
        expect(port).toBe(443);
        return tcpConnect(destinationPort, "127.0.0.1");
      },
    });
    const client = tcpConnect(proxy.port, "127.0.0.1");
    try {
      client.write("CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n");
      const handshake = await waitForData(client);
      expect(handshake.toString()).toContain("200 Connection Established");
      client.write("pinned");
      await expect(waitForData(client)).resolves.toEqual(Buffer.from("pinned"));
    } finally {
      client.destroy();
      await proxy.close();
      destination.close();
    }
  });
});
