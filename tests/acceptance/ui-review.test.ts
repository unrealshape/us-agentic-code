import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../packages/ui/src/server";

type Hono = ReturnType<typeof createApp>;
import { openStore, type Store } from "../../packages/daemon/src/store";
import { git } from "../../packages/daemon/src/exec";
import { parseUnifiedDiff, renderDiff } from "../../packages/ui/src/diff";
import { registerReview, reviewData } from "../../packages/ui/src/views/review";
import { checkRequest, registerActions, type Guard } from "../../packages/ui/src/actions";

const SAMPLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,4 @@ export function f() {",
  " const x = 1;",
  "-const y = 2;",
  "+const y = 3;",
  " const z = 4;",
  " return x;",
  "diff --git a/src/neu.ts b/src/neu.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/neu.ts",
  "@@ -0,0 +1,2 @@",
  "+export const neu = 1;",
  "+-- kein Kopf, sondern Inhalt",
  "",
].join("\n");

const G: Guard = { token: "a".repeat(64), port: 7777 };

function setup(status: "awaiting_approval" | "running" = "awaiting_approval") {
  const store = openStore(":memory:");
  store.createWorkItem({ id: "w1", projectPath: "/p/proj", type: "bugfix", title: "T", description: "d", size: "S" } as never);
  store.updateWorkItem("w1", { status });
  // Ein paar Freigaben, damit die Freigabe-ID 5 existiert.
  for (let i = 0; i < 4; i++) store.resolveApproval(store.createApproval("w1", "h1", {}).id, true);
  const a = store.createApproval("w1", "h2", {});
  expect(a.id).toBe(5);
  const app = createApp(store);
  registerActions(app, store, G);
  return { store, app };
}

function post(app: Hono, headers: Record<string, string>, body: unknown = { granted: true }) {
  return app.request("http://127.0.0.1:7777/api/approvals/5", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const OK_HEADERS = { "X-Usac-Token": G.token, Origin: "http://127.0.0.1:7777", Host: "127.0.0.1:7777" };

describe("Review-Ansicht", () => {
  test("Diff wird geparst", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/neu.ts"]);
    const a = files[0]!.hunks[0]!;
    expect(a.header).toBe("@@ -10,4 +10,4 @@ export function f() {");
    expect(a.lines).toEqual([
      { kind: "ctx", oldNo: 10, newNo: 10, text: "const x = 1;" },
      { kind: "del", oldNo: 11, text: "const y = 2;" },
      { kind: "add", newNo: 11, text: "const y = 3;" },
      { kind: "ctx", oldNo: 12, newNo: 12, text: "const z = 4;" },
      { kind: "ctx", oldNo: 13, newNo: 13, text: "return x;" },
    ]);
    const neu = files[1]!.hunks[0]!.lines;
    expect(neu).toEqual([
      { kind: "add", newNo: 1, text: "export const neu = 1;" },
      { kind: "add", newNo: 2, text: "-- kein Kopf, sondern Inhalt" },
    ]);
  });

  test("gelöschte Datei behält ihren Pfad", () => {
    const files = parseUnifiedDiff(
      ["diff --git a/alt.lua b/alt.lua", "deleted file mode 100644", "--- a/alt.lua", "+++ /dev/null", "@@ -1 +0,0 @@", "-weg", ""].join("\n"),
    );
    expect(files).toEqual([{ path: "alt.lua", hunks: [{ header: "@@ -1 +0,0 @@", lines: [{ kind: "del", oldNo: 1, text: "weg" }] }] }]);
  });

  test("Befund hängt an der Zeile", () => {
    const files = parseUnifiedDiff(SAMPLE);
    const html = renderDiff(files, [
      { severity: "high", text: "Befund-an-Zeile-12", evidence: [{ type: "file", path: "src/a.ts", lines: [12, 12], quote: "const z = 4;" }] },
    ]);
    const row12 = html.indexOf("const z = 4;");
    const finding = html.indexOf("Befund-an-Zeile-12");
    const row13 = html.indexOf("return x;");
    expect(row12).toBeGreaterThan(-1);
    expect(finding).toBeGreaterThan(row12);
    expect(finding).toBeLessThan(row13);
  });

  test("Escaping im Diff", () => {
    const diff = ["--- a/x.html", "+++ b/x.html", "@@ -0,0 +1 @@", "+ </textarea><script>x</script>", ""].join("\n");
    const html = renderDiff(parseUnifiedDiff(diff), [
      { severity: "low", text: "<img src=x onerror=alert(1)>", evidence: [{ type: "file", path: "x.html", lines: [1, 1], quote: "q" }] },
    ]);
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("</textarea>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;x&lt;/script&gt;");
  });

  test("Worktree fehlt", async () => {
    const store = openStore(":memory:");
    store.createWorkItem({ id: "w9", projectPath: "/p/proj", type: "bugfix", title: "T", description: "d", size: "S" } as never);
    store.updateWorkItem("w9", { worktree: join(tmpdir(), "usac-gibt-es-nicht-9f3e"), state: { phase: "integrate", baseRef: "abc" } });
    const data = await reviewData(store, "w9");
    expect(data.unavailable).toBe("Worktree nicht mehr vorhanden (nach Merge entfernt)");
    expect(data.files).toEqual([]);
    const app = createApp(store);
    registerReview(app, store, G);
    const res = await app.request("http://127.0.0.1:7777/runs/w9/review");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Worktree nicht mehr vorhanden (nach Merge entfernt)");
  });

  test("Diff, Befunde und Gates aus Worktree und Event-Log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usac-review-"));
    try {
      await git(dir, "init", "-q");
      await git(dir, "config", "user.email", "t@t");
      await git(dir, "config", "user.name", "t");
      writeFileSync(join(dir, "a.lua"), "local a = 1\nreturn a\n");
      await git(dir, "add", ".");
      await git(dir, "commit", "-qm", "basis");
      const base = await git(dir, "rev-parse", "HEAD");
      writeFileSync(join(dir, "a.lua"), "local a = 2\nreturn a\n");
      await git(dir, "commit", "-qam", "aenderung");
      const store = openStore(":memory:");
      store.createWorkItem({ id: "w2", projectPath: dir, type: "bugfix", title: "T", description: "d", size: "S" } as never);
      store.updateWorkItem("w2", { worktree: dir, status: "awaiting_approval", state: { phase: "integrate", baseRef: base } });
      store.recordGate({ workItemId: "w2", name: "test", status: "passed", exitCode: 0, durationMs: 5, output: "" });
      const finding = { severity: "medium", text: "Wert geaendert", evidence: [{ type: "file", path: "a.lua", lines: [1, 1], quote: "local a = 2" }] };
      store.append({ traceId: "w2", spanId: "w2", project: "p", type: "review.seat", actor: "orchestrator", data: { role: "reviewer", findings: [finding] } });
      const approval = store.createApproval("w2", "h2", {});
      const data = await reviewData(store, "w2");
      expect(data.unavailable).toBeUndefined();
      expect(data.files.map((f) => f.path)).toEqual(["a.lua"]);
      expect(data.findings.map((f) => f.text)).toEqual(["Wert geaendert"]);
      expect(data.gates.map((g) => g.name)).toEqual(["test"]);
      expect(data.approval?.id).toBe(approval.id);
      const app = createApp(store);
      registerReview(app, store, G);
      const html = await (await app.request("http://127.0.0.1:7777/runs/w2/review")).text();
      expect(html).toContain(`<meta name="usac-token" content="${G.token}">`);
      expect(html.indexOf("Wert geaendert")).toBeGreaterThan(html.indexOf("local a = 2"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Freigabe über die UI", async () => {
    const { store, app } = setup();
    const res = await post(app, OK_HEADERS, { granted: true, note: "passt" });
    expect(res.status).toBe(200);
    expect(store.getApproval(5)!.status).toBe("granted");
    expect(store.getApproval(5)!.note).toBe("passt");
    const ev = store.events({ type: "approval.resolved" });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toEqual({ approval_id: 5, granted: true, by: "ui" });
    expect(store.getWorkItem("w1")!.status).toBe("queued");
  });

  test("Ablehnung über die UI", async () => {
    const { store, app } = setup();
    expect((await post(app, OK_HEADERS, { granted: false })).status).toBe(200);
    expect(store.getApproval(5)!.status).toBe("denied");
    // Bereits entschiedene Freigaben lassen sich nicht umdrehen.
    expect((await post(app, OK_HEADERS, { granted: true })).status).toBe(409);
    expect(store.getApproval(5)!.status).toBe("denied");
  });

  test("CSRF und Rebinding", async () => {
    const { store, app } = setup();
    const { "X-Usac-Token": _t, ...noToken } = OK_HEADERS;
    const cases: Record<string, string>[] = [
      noToken,
      { ...OK_HEADERS, "X-Usac-Token": "b".repeat(64) },
      { ...OK_HEADERS, "X-Usac-Token": "kurz" },
      { ...OK_HEADERS, Origin: "http://evil.test" },
      { ...OK_HEADERS, Host: "evil.test:7777" },
    ];
    for (const h of cases) expect((await post(app, h)).status).toBe(403);
    expect(store.getApproval(5)!.status).toBe("pending");
    expect(store.events({ type: "approval.resolved" })).toHaveLength(0);
    expect(store.getWorkItem("w1")!.status).toBe("awaiting_approval");
  });

  test("checkRequest nennt den Grund", () => {
    const req = (h: Record<string, string>, method = "POST") => new Request("http://127.0.0.1:7777/api/approvals/5", { method, headers: h });
    expect(checkRequest(req(OK_HEADERS), G)).toBeNull();
    expect(checkRequest(req(OK_HEADERS, "GET"), G)).toBeString();
    const { Origin: _o, ...noOrigin } = OK_HEADERS;
    expect(checkRequest(req(noOrigin), G)).toBeString();
  });

  test("GET ändert nichts", async () => {
    const { store, app } = setup();
    const res = await app.request("http://127.0.0.1:7777/api/approvals/5", { headers: OK_HEADERS });
    expect(res.status).toBe(405);
    expect(store.getApproval(5)!.status).toBe("pending");
  });
});
