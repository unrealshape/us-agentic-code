import { describe, expect, test } from "bun:test";
import { createApp, startServer } from "../../packages/ui/src/server";
import { openStore, type Store } from "../../packages/daemon/src/store";
import { inboxHtml } from "../../packages/ui/src/views/inbox";
import { wallHtml } from "../../packages/ui/src/views/wall";

const TOKEN = "c".repeat(64);

/** Store mit einer offenen Freigabe (ID 1) und einer erledigten Freigabe. */
function seeded(): Store {
  const store = openStore(":memory:");
  store.createWorkItem({ id: "w1", projectPath: "/p/proj", type: "bugfix", title: "Rotation", description: "d", size: "S" } as never);
  store.createWorkItem({ id: "w2", projectPath: "/p/proj", type: "bugfix", title: "Cooldown", description: "d", size: "S" } as never);
  store.createApproval("w1", "h1", {});
  const done = store.createApproval("w2", "h2", {});
  store.resolveApproval(done.id, true);
  return store;
}

describe("Inbox interaktiv", () => {
  test("mit Guard: Buttons je offener Freigabe und Token-Meta", () => {
    const store = seeded();
    const html = inboxHtml(store, TOKEN);
    expect(html).toContain('data-approval="1"');
    expect(html).toContain('data-granted="true"');
    expect(html).toContain('data-granted="false"');
    expect(html).toContain('type="button"');
    expect(html).toContain(`<meta name="usac-token" content="${TOKEN}">`);
    // Erledigte Freigaben bekommen keine Buttons.
    expect(html.match(/data-approval=/g)).toHaveLength(2);
  });

  test("ohne Guard: keine Buttons, kein Token", () => {
    const html = inboxHtml(seeded());
    expect(html).not.toContain("data-approval");
    expect(html).not.toContain("usac-token");
    expect(html).toContain("/runs/w1/review");
  });

  test("createApp ohne Guard liefert keine Buttons", async () => {
    const app = createApp(seeded());
    const html = await (await app.request("http://127.0.0.1:7777/")).text();
    expect(html).not.toContain("data-approval");
  });
});

describe("Agent-Wand interaktiv", () => {
  test("Kacheln sind Schaltflächen mit Auswahl und Ereignisbereich", () => {
    const html = wallHtml(seeded());
    expect(html).toContain('<button type="button" class="pick" data-run="w1" aria-pressed="false"');
    expect(html).toContain('data-run="w2"');
    expect(html).toContain('id="run-detail"');
    expect(html).toContain("/api/runs/");
  });

  test("leere Wand hat keinen Auswahlbereich mit Kacheln", () => {
    const html = wallHtml(openStore(":memory:"));
    expect(html).not.toContain("data-run=");
  });
});

describe("Schreibaktion über echten HTTP-Server", () => {
  test("fremder Host 403, korrekter Host mit Token 200", async () => {
    const store = seeded();
    const srv = startServer(store, { port: 0 });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // Token steht nur auf der Inbox-Seite (Meta-Tag), nie in der URL.
      const page = await (await fetch(`${base}/`)).text();
      const token = /<meta name="usac-token" content="([0-9a-f]{64})">/.exec(page)?.[1];
      expect(token).toBeString();
      const id = store.pendingApprovals()[0]!.id;
      const body = JSON.stringify({ granted: true });
      const foreign = await fetch(`${base}/api/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Usac-Token": token!, Host: "evil.test:1" },
        body,
      });
      expect(foreign.status).toBe(403);
      expect(store.getApproval(id)!.status).toBe("pending");

      const ok = await fetch(`${base}/api/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Usac-Token": token!, Origin: base },
        body,
      });
      expect(ok.status).toBe(200);
      expect(store.getApproval(id)!.status).toBe("granted");
    } finally {
      srv.stop(true);
    }
  });
});
