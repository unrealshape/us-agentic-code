import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../helpers";

const PUBLIC = join(REPO_ROOT, "packages/ui/public");
const read = (name: string) => readFileSync(join(PUBLIC, name), "utf8");

type UsacEventLike = { id: number; ts: string; traceId: string; spanId: string; project: string; type: string; actor: string; data: unknown };
type NotifyModule = { toNotification: (event: UsacEventLike) => { title: string; body: string; url: string; tag: string } | null };
// Eigene Typisierung statt Import: notify.js ist ein Browser-Skript ohne Typdatei (tsc ohne allowJs).
const NOTIFY_PATH = join(PUBLIC, "notify.js");
const { toNotification } = (await import(NOTIFY_PATH)) as NotifyModule;

describe("UI als PWA mit lokalen Benachrichtigungen (Phase 5, ADR 0010)", () => {
  test("Manifest ist gültig", () => {
    const manifest = JSON.parse(read("manifest.webmanifest"));
    expect(manifest.name).toBe("US-AGENTIC-CODE");
    expect(manifest.short_name).toBe("usac");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(Array.isArray(manifest.icons)).toBe(true);
    const icon = manifest.icons.find((i: { src: string }) => i.src.endsWith("icon.svg"));
    expect(icon).toBeDefined();
    expect(icon.sizes).toBe("any");
    expect(icon.type).toBe("image/svg+xml");
    expect(read("icon.svg")).toContain("<svg");
  });

  test("Service Worker cacht keine API und keinen WebSocket", () => {
    const sw = read("sw.js");
    expect(sw).toContain("/api/");
    expect(sw).toContain("/ws");
    expect(sw).toMatch(/install/);
    for (const shell of ["/palette.js", "/notify.js", "/icon.svg"]) {
      expect(sw).toContain(shell);
    }
  });

  test("Service Worker öffnet die URL aus der Benachrichtigung", () => {
    const sw = read("sw.js");
    expect(sw).toContain("notificationclick");
    expect(sw).toContain("data.url");
  });

  test("Benachrichtigung nur nach Nutzeraktion", () => {
    const js = read("notify.js");
    const listener = js.indexOf('getElementById("notify-enable")');
    const request = js.indexOf("Notification.requestPermission");
    expect(listener).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(-1);
    // Der Aufruf steht im Klick-Handler des Buttons, nicht auf Modulebene.
    expect(request).toBeGreaterThan(listener);
    expect(js.slice(listener, request)).toMatch(/addEventListener\(\s*"click"/);
    expect(js.match(/Notification\.requestPermission/g)?.length).toBe(1);
  });

  test("Keine externen Dateien", () => {
    for (const name of ["manifest.webmanifest", "sw.js", "notify.js"]) {
      expect(read(name)).not.toMatch(/https?:\/\//);
    }
    // Der SVG-Namensraum ist ein Bezeichner, kein Ladeziel; geprüft werden nur Verweise.
    expect(read("icon.svg")).not.toMatch(/(href|src)\s*=\s*["']https?:/);
  });

  test("Ereignis-Zuordnung: Freigabe und Problemmeldungen", () => {
    const approval = toNotification({
      id: 7,
      ts: "2026-11-18T10:00:00Z",
      traceId: "w1",
      spanId: "w1",
      project: "p",
      type: "approval.requested",
      actor: "orchestrator",
      data: { approval_id: 5, kind: "h2" },
    });
    expect(approval).not.toBeNull();
    expect(approval?.title).toBe("Freigabe h2");
    expect(approval?.url).toBe("/runs/w1/review");
    expect(approval?.tag).toBe("7");

    const escalated = toNotification({
      id: 8,
      ts: "2026-11-18T10:01:00Z",
      traceId: "w2",
      spanId: "w2",
      project: "p",
      type: "workitem.escalated",
      actor: "orchestrator",
      data: {},
    });
    expect(escalated).not.toBeNull();
    expect(escalated?.url).toBe("/runs/w2");

    const output = toNotification({
      id: 9,
      ts: "2026-11-18T10:02:00Z",
      traceId: "w3",
      spanId: "w3",
      project: "p",
      type: "run.output",
      actor: "runner",
      data: { text: "hallo" },
    });
    expect(output).toBeNull();
  });
});
