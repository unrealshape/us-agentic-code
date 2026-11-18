import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedLines, coverageDiff, DEFAULT_COVERAGE_THRESHOLD, parseLcov } from "../src/coverage-diff";
import { git } from "../src/exec";

describe("parseLcov", () => {
  test("lcov wird gelesen", () => {
    const text = ["TN:", "SF:/abs/root/src/a.ts", "DA:3,1", "DA:4,0", "end_of_record", ""].join("\n");
    const cov = parseLcov(text, "/abs/root");
    expect([...cov.keys()]).toEqual(["src/a.ts"]);
    expect(Object.fromEntries(cov.get("src/a.ts")!)).toEqual({ 3: 1, 4: 0 });
  });

  test("Windows-Pfade in lcov", () => {
    const text = ["SF:C:\\root\\src\\a.ts", "DA:1,2", "end_of_record"].join("\r\n");
    const cov = parseLcov(text, "C:\\root");
    expect([...cov.keys()]).toEqual(["src/a.ts"]);
    expect(cov.get("src/a.ts")!.get(1)).toBe(2);
  });
});

describe("coverageDiff", () => {
  test("Standardschwelle", () => {
    expect(DEFAULT_COVERAGE_THRESHOLD).toBe(0.8);
  });

  test("nur geänderte Zeilen zählen", () => {
    const cov = new Map([["src/a.ts", new Map([[3, 1], [4, 0]])]]);
    const r = coverageDiff(cov, new Map([["src/a.ts", [3, 4, 9]]]));
    expect(r.total).toBe(2);
    expect(r.covered).toBe(1);
    expect(r.ratio).toBe(0.5);
    expect(r.uncovered).toEqual([{ file: "src/a.ts", lines: [4] }]);
  });

  test("neue Datei ohne lcov-Eintrag", () => {
    const r = coverageDiff(new Map(), new Map([["src/new.ts", [1, 2]]]));
    expect(r.total).toBe(2);
    expect(r.covered).toBe(0);
    expect(r.uncovered).toContainEqual({ file: "src/new.ts", lines: [1, 2] });
  });

  test("keine ausführbare Änderung", () => {
    const cov = new Map([["src/a.ts", new Map([[3, 1]])]]);
    const r = coverageDiff(cov, new Map([["src/a.ts", [10, 11]]]));
    expect(r.total).toBe(0);
    expect(r.ratio).toBe(1);
    expect(r.uncovered).toEqual([]);
  });
});

describe("changedLines", () => {
  test("eine geänderte Zeile im Temp-Repo, Testdatei außerhalb include fehlt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usac-covdiff-"));
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "test"));
      writeFileSync(join(dir, "src", "a.ts"), "l1\nl2\nl3\nl4\nl5\n");
      writeFileSync(join(dir, "test", "a.test.ts"), "t1\n");
      await git(dir, "init", "-q");
      await git(dir, "add", ".");
      await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
      writeFileSync(join(dir, "src", "a.ts"), "l1\nl2\nNEU\nl4\nl5\n");
      writeFileSync(join(dir, "test", "a.test.ts"), "t1\nt2\n");
      const changed = await changedLines(dir, "HEAD", ["src/**/*.ts"]);
      expect([...changed.keys()]).toEqual(["src/a.ts"]);
      expect(changed.get("src/a.ts")).toEqual([3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
