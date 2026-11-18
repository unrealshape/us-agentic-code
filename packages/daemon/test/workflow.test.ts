import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow } from "../src/workflow";

describe("workflow", () => {
  test("lädt bugfix.yaml und liefert Phasen in Reihenfolge", () => {
    const wf = loadWorkflow(join(import.meta.dir, "../../../workflows/bugfix.yaml"));
    expect(wf.name).toBe("bugfix");
    expect(wf.phases.map((p) => p.name)).toEqual([
      "setup", "acceptance", "approve_h1", "lock", "implement", "review", "integrate",
    ]);
  });

  test("lehnt Phase ohne Namen ab", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const p = join(dir, "bad.yaml");
    writeFileSync(p, "name: bad\nphases:\n  - role: x\n");
    expect(() => loadWorkflow(p)).toThrow();
  });
});
