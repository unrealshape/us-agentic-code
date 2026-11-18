import { describe, expect, test } from "bun:test";
import { SECURITY_TRIGGERS, securityTriggers } from "../src/triggers";
import { reviewSeats } from "../src/review";

const diff = (...lines: string[]) => ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", ...lines].join("\n");

describe("Security-Trigger", () => {
  test("genau die vereinbarten Namen", () => {
    expect(SECURITY_TRIGGERS.map((t) => t.name)).toEqual(["auth", "crypto", "secrets", "sql", "exec", "filesystem", "network", "dependencies", "ci"]);
  });

  test("auth: Pfad", () => {
    expect(securityTriggers(["src/auth/login.ts"], "")).toEqual(["auth"]);
    expect(securityTriggers(["src/author.ts"], "")).toEqual([]);
  });

  test("crypto: nur hinzugefuegte Zeilen", () => {
    expect(securityTriggers([], diff('+ const h = createHash("sha256")'))).toEqual(["crypto"]);
    expect(securityTriggers([], diff('- const h = createHash("sha256")'))).toEqual([]);
    expect(securityTriggers([], diff('  const h = createHash("sha256")'))).toEqual([]);
  });

  test("Diff-Kopfzeilen (+++) zaehlen nicht", () => {
    expect(securityTriggers([], "+++ b/src/createHash.ts\n+++ b/API_KEY = 1")).toEqual([]);
  });

  test("secrets", () => {
    expect(securityTriggers([], diff('+ API_KEY = "..."'))).toEqual(["secrets"]);
    expect(securityTriggers([], diff('- API_KEY = "..."'))).toEqual([]);
    expect(securityTriggers([".env"], "")).toEqual(["secrets"]);
    expect(securityTriggers(["src/environment.ts"], "")).toEqual([]);
  });

  test("sql", () => {
    expect(securityTriggers([], diff('+ db.query("SELECT * FROM users WHERE id = " + id)'))).toEqual(["sql"]);
    expect(securityTriggers(["db/migrations/001_init.sql"], "")).toEqual(["sql"]);
    expect(securityTriggers([], diff("+ const selection = items.filter(Boolean)"))).toEqual([]);
  });

  test("exec", () => {
    expect(securityTriggers([], diff("+ child_process.exec(cmd)"))).toEqual(["exec"]);
    expect(securityTriggers([], diff('+ subprocess.run(["ls"])'))).toEqual(["exec"]);
    expect(securityTriggers([], diff('+ os.execute("rm -rf /tmp/x")'))).toEqual(["exec"]);
    expect(securityTriggers([], diff("+ const m = /a/.exec(s)"))).toEqual([]);
  });

  test("filesystem", () => {
    expect(securityTriggers([], diff("+ fs.rmSync(dir, { recursive: true })"))).toEqual(["filesystem"]);
    expect(securityTriggers([], diff("+ shutil.rmtree(path)"))).toEqual(["filesystem"]);
    expect(securityTriggers([], diff("+ const files = list.length"))).toEqual([]);
  });

  test("network", () => {
    expect(securityTriggers([], diff('+ await fetch("https://example.org")'))).toEqual(["network"]);
    expect(securityTriggers([], diff("+ requests.get(url)"))).toEqual(["network"]);
    expect(securityTriggers([], diff("+ prefetch(items)"))).toEqual([]);
  });

  test("dependencies", () => {
    for (const p of ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "pom.xml", "sub/dir/package.json"]) {
      expect(securityTriggers([p], "")).toEqual(["dependencies"]);
    }
    expect(securityTriggers(["src/package.ts"], "")).toEqual([]);
  });

  test("ci", () => {
    expect(securityTriggers([".github/workflows/ci.yml"], "")).toEqual(["ci"]);
    expect(securityTriggers(["docs/ci.md"], "")).toEqual([]);
  });

  test("mehrere Trigger in fester Reihenfolge, ohne Duplikate", () => {
    expect(securityTriggers(["package.json", "src/auth/a.ts", "src/auth/b.ts"], diff("+ await fetch(u)"))).toEqual(["auth", "network", "dependencies"]);
  });
});

describe("Review-Sitze", () => {
  test("Standard: ein Code-Review", () => {
    expect(reviewSeats("small", [])).toEqual([{ role: "code-reviewer", reason: "standard" }]);
  });

  test("large ohne Trigger: zwei Code-Reviews", () => {
    expect(reviewSeats("large", [])).toEqual([
      { role: "code-reviewer", reason: "standard" },
      { role: "code-reviewer", reason: "size_large" },
    ]);
  });

  test("Trigger: Zweitpruefer ist security-reviewer", () => {
    expect(reviewSeats("small", ["auth"])).toEqual([
      { role: "code-reviewer", reason: "standard" },
      { role: "security-reviewer", reason: "security" },
    ]);
  });

  test("large mit Trigger: hoechstens zwei Sitze", () => {
    const seats = reviewSeats("large", ["auth"]);
    expect(seats).toHaveLength(2);
    expect(seats[1]).toEqual({ role: "security-reviewer", reason: "security" });
  });
});
