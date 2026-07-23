import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { FetchWorkshopTransport } from "../src/workshop.js";

test("protocol transport refuses redirects, response bombs, and stalled requests", async () => {
  let behavior: "redirect" | "bomb" | "stall" = "redirect";
  const server = createServer((_request, response) => {
    if (behavior === "redirect") {
      response.writeHead(302, { location: "/other" });
      response.end();
    } else if (behavior === "bomb") {
      response.writeHead(200, { "content-type": "application/json", "content-length": "2048" });
      response.end("x".repeat(2048));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const endpoint = new URL(`http://127.0.0.1:${(address as { port: number }).port}/mcp`);
  const transport = new FetchWorkshopTransport(1000, 1024);
  try {
    await assert.rejects(transport.call(endpoint, "selector-token", "initialize", {}), /fetch|redirect/iu);
    behavior = "bomb";
    await assert.rejects(transport.call(endpoint, "selector-token", "initialize", {}), /response exceeds/iu);
    behavior = "stall";
    const timeoutTransport = new FetchWorkshopTransport(40, 1024);
    await assert.rejects(timeoutTransport.call(endpoint, "selector-token", "initialize", {}), /abort|fetch/iu);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
