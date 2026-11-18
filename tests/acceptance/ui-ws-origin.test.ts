import { describe, expect, test } from "bun:test";
import { openStore } from "../../packages/daemon/src/store";
import { startServer } from "../../packages/ui/src/server";

// Abnahme: Der Event-Strom /ws darf nur für die eigene Seite (Origin 127.0.0.1:<port>) offen sein.
// Ohne diese Prüfung kann jede Website im Browser den Strom mitlesen (Cross-Site-WebSocket).

function tryWs(url: string, origin: string): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } } as unknown as string[]);
    ws.onopen = () => {
      ws.close();
      resolve("open");
    };
    ws.onerror = () => resolve("rejected");
    ws.onclose = () => resolve("rejected");
  });
}

describe("UI: /ws nur für die eigene Origin", () => {
  test("fremde Origin wird abgewiesen", async () => {
    const server = startServer(openStore(":memory:"), { port: 0 });
    try {
      const result = await tryWs(`ws://127.0.0.1:${server.port}/ws`, "http://evil.example");
      expect(result).toBe("rejected");
    } finally {
      server.stop(true);
    }
  });

  test("eigene Origin 127.0.0.1:<port> wird angenommen", async () => {
    const server = startServer(openStore(":memory:"), { port: 0 });
    try {
      const result = await tryWs(`ws://127.0.0.1:${server.port}/ws`, `http://127.0.0.1:${server.port}`);
      expect(result).toBe("open");
    } finally {
      server.stop(true);
    }
  });
});
