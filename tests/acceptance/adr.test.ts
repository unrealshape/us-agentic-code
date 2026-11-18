/**
 * Abnahme Phase 3, Task 8: ADR-Verwaltung und ADR-Pflicht fuer neue Abhaengigkeiten (Regel 6).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ACCEPTANCE_SPEC, FIXED_ROTATION, git, REPO_ROOT, setupProject, tempHome } from "../helpers";
import { createAdr, listAdrs, setAdrStatus } from "../../packages/daemon/src/adr";
import { checkAdrRule, newDependencies } from "../../packages/daemon/src/adr-check";
import { checkEvidence } from "../../packages/daemon/src/evidence";
import { createOrchestrator } from "../../packages/daemon/src/orchestrator";
import { registerPhase, restorePhases, snapshotPhases } from "../../packages/daemon/src/phases";
import { createReviewHandler } from "../../packages/daemon/src/review";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore } from "../../packages/daemon/src/store";

const ADR_TEXT = "Neue Abhängigkeit left-pad ohne ADR (Regel 6)";

/** Git-Repo mit den gegebenen Dateien als Basis-Commit; gibt Pfad und Basis-SHA zurueck. */
function repo(files: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "usac-adr-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@usac.local");
  git(dir, "config", "user.name", "usac-test");
  writeFileSync(join(dir, "README.md"), "# Projekt\n");
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: initial");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

const PKG_BASE = JSON.stringify({ name: "demo", dependencies: { zod: "3.23.0" }, devDependencies: { typescript: "5.6.0" } }, null, 2) + "\n";
const PKG_NEW = JSON.stringify({ name: "demo", dependencies: { zod: "3.23.0", "left-pad": "1.3.0" }, devDependencies: { typescript: "5.6.0" } }, null, 2) + "\n";

describe("ADR-Verwaltung (Phase 3)", () => {
  test("listAdrs liest die ADRs dieses Repos", () => {
    const dir = mkdtempSync(join(tmpdir(), "usac-adr-list-"));
    for (const f of readdirSync(join(REPO_ROOT, "docs/adr")).filter((f) => /^000[1-3]-.*\.md$/.test(f))) {
      copyFileSync(join(REPO_ROOT, "docs/adr", f), join(dir, f));
    }
    const adrs = listAdrs(dir);
    expect(adrs.map((a) => a.number)).toEqual([1, 2, 3]);
    expect(adrs[0]!.status).toBe("angenommen");
    expect(adrs[0]!.title).toBe("Fundament von Phase 0");
    expect(adrs[1]!.status).toBe("entwurf");
    expect(adrs[1]!.openQuestions.some((q) => q.includes("Kontingent"))).toBe(true);
    expect(adrs[2]!.path).toBe(join(dir, readdirSync(dir).find((f) => f.startsWith("0003-"))!));
  });

  test("createAdr vergibt die nächste Nummer", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "usac-adr-new-")), "docs/adr");
    const first = createAdr(dir, "Erste Entscheidung", "2026-11-18");
    expect(basename(first)).toMatch(/^0001-/);
    const second = createAdr(dir, "Größere Änderung für Übersetzungen", "2026-11-18");
    expect(basename(second)).toBe("0002-groessere-aenderung-fuer-uebersetzungen.md");
    expect(basename(second)).toMatch(/^[\x20-\x7e]+$/);

    const text = readFileSync(second, "utf8");
    expect(text).toContain("# ADR 0002: Größere Änderung für Übersetzungen");
    expect(text).toContain("Status: Entwurf");
    expect(text).toContain("2026-11-18");
    for (const h of ["## Kontext", "## Entscheidung", "## Folgen", "## Offene Fragen"]) expect(text).toContain(h);

    const adrs = listAdrs(dir);
    expect(adrs.map((a) => [a.number, a.status])).toEqual([
      [1, "entwurf"],
      [2, "entwurf"],
    ]);
  });

  test("setAdrStatus mit Ablösung", () => {
    const dir = mkdtempSync(join(tmpdir(), "usac-adr-status-"));
    const p = createAdr(dir, "Alt", "2026-11-18");
    setAdrStatus(p, "angenommen");
    expect(listAdrs(dir)[0]!.status).toBe("angenommen");
    setAdrStatus(p, "abgeloest", 3);
    const lines = readFileSync(p, "utf8").split("\n");
    expect(lines).toContain("Status: abgelöst durch ADR 0003");
    expect(lines.filter((l) => l.startsWith("Status:"))).toHaveLength(1);
    const info = listAdrs(dir)[0]!;
    expect(info.status).toBe("abgeloest");
    expect(info.supersededBy).toBe(3);
  });
});

describe("ADR-Pflicht für neue Abhängigkeiten (Regel 6)", () => {
  test("neue Abhängigkeit ohne ADR blockiert das Review", () => {
    const { dir, base } = repo({ "package.json": PKG_BASE });
    writeFileSync(join(dir, "package.json"), PKG_NEW);
    expect(newDependencies(dir, base)).toEqual([{ manifest: "package.json", name: "left-pad" }]);

    const findings = checkAdrRule(dir, base, "docs/adr");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.text).toBe(ADR_TEXT);
    expect(findings[0]!.evidence).toHaveLength(1);
    const ev = findings[0]!.evidence[0]!;
    expect(ev).toMatchObject({ type: "file", path: "package.json" });
    if (ev.type !== "file") throw new Error("file-Beleg erwartet");
    expect(ev.quote).toContain("left-pad");
    expect(checkEvidence(ev, { cwd: dir, store: openStore(":memory:"), workItemId: "wi" })).toBeNull();

    // Mit neuer (unversionierter) Datei unter docs/adr: kein Befund.
    createAdr(join(dir, "docs/adr"), "left-pad aufnehmen", "2026-11-18");
    expect(checkAdrRule(dir, base, "docs/adr")).toEqual([]);
  });

  test("geändertes bestehendes ADR genügt ebenfalls", () => {
    const { dir, base } = repo({ "package.json": PKG_BASE });
    mkdirSync(join(dir, "docs/adr"), { recursive: true });
    const p = createAdr(join(dir, "docs/adr"), "Abhängigkeiten", "2026-11-18");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "docs: ADR");
    const base2 = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "package.json"), PKG_NEW);
    expect(checkAdrRule(dir, base2, "docs/adr")).toHaveLength(1);
    writeFileSync(p, readFileSync(p, "utf8") + "\n- left-pad für Polsterung\n");
    expect(checkAdrRule(dir, base2, "docs/adr")).toEqual([]);
    expect(base).not.toBe(base2);
  });

  test("je Manifest ein Fall", () => {
    const cases: { file: string; before: string; after: string; name: string }[] = [
      {
        file: "go.mod",
        before: "module example.com/demo\n\ngo 1.22\n\nrequire (\n\tgithub.com/stretchr/testify v1.8.0\n)\n",
        after: "module example.com/demo\n\ngo 1.22\n\nrequire (\n\tgithub.com/stretchr/testify v1.9.0\n\tgithub.com/google/uuid v1.6.0\n)\n",
        name: "github.com/google/uuid",
      },
      {
        file: "Cargo.toml",
        before: '[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\n\n[dev-dependencies]\ninsta = "1.0"\n',
        after: '[package]\nname = "demo"\nversion = "0.2.0"\n\n[dependencies]\nserde = "1.1"\nrand = { version = "0.8" }\n\n[dev-dependencies]\ninsta = "1.0"\n',
        name: "rand",
      },
      {
        file: "pyproject.toml",
        before: '[project]\nname = "demo"\ndependencies = [\n  "requests>=2.0",\n]\n',
        after: '[project]\nname = "demo"\ndependencies = [\n  "requests>=2.31",\n  "httpx==0.27",\n]\n',
        name: "httpx",
      },
      {
        file: "requirements.txt",
        before: "# Basis\nrequests==2.0\n",
        after: "# Basis\nrequests==2.31\nflask>=3.0\n",
        name: "flask",
      },
      {
        file: "Demo.csproj",
        before: '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Serilog" Version="3.0.0" />\n  </ItemGroup>\n</Project>\n',
        after:
          '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Serilog" Version="3.1.0" />\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n  </ItemGroup>\n</Project>\n',
        name: "Newtonsoft.Json",
      },
      {
        file: "pom.xml",
        before:
          "<project>\n  <artifactId>demo</artifactId>\n  <dependencies>\n    <dependency>\n      <groupId>junit</groupId>\n      <artifactId>junit</artifactId>\n      <version>4.12</version>\n    </dependency>\n  </dependencies>\n</project>\n",
        after:
          "<project>\n  <artifactId>demo</artifactId>\n  <dependencies>\n    <dependency>\n      <groupId>junit</groupId>\n      <artifactId>junit</artifactId>\n      <version>4.13</version>\n    </dependency>\n    <dependency>\n      <groupId>com.google.guava</groupId>\n      <artifactId>guava</artifactId>\n      <version>33.0</version>\n    </dependency>\n  </dependencies>\n</project>\n",
        name: "guava",
      },
    ];
    for (const c of cases) {
      const { dir, base } = repo({ [c.file]: c.before });
      writeFileSync(join(dir, c.file), c.after);
      expect({ file: c.file, deps: newDependencies(dir, base) }).toEqual({ file: c.file, deps: [{ manifest: c.file, name: c.name }] });
      const findings = checkAdrRule(dir, base, "docs/adr");
      expect(findings).toHaveLength(1);
      const ev = findings[0]!.evidence[0]!;
      expect(checkEvidence(ev, { cwd: dir, store: openStore(":memory:"), workItemId: "wi" })).toBeNull();
    }
  });

  test("Versionsänderung allein ist keine neue Abhängigkeit", () => {
    const { dir, base } = repo({ "package.json": PKG_BASE, "requirements-dev.txt": "pytest==7.0\n" });
    writeFileSync(join(dir, "package.json"), PKG_BASE.replace("3.23.0", "3.24.0"));
    writeFileSync(join(dir, "requirements-dev.txt"), "pytest==8.0\n");
    expect(newDependencies(dir, base)).toEqual([]);
    expect(checkAdrRule(dir, base, "docs/adr")).toEqual([]);
  });
});

describe("Review mit ADR-Pflicht", () => {
  let snap: ReturnType<typeof snapshotPhases>;
  beforeEach(() => {
    snap = snapshotPhases();
    registerPhase("review", createReviewHandler());
  });
  afterEach(() => restorePhases(snap));

  const ACC_PATH = "spec/acceptance/cooldown_spec.lua";
  const testEngineerOk: Handler = async (spec) => {
    mkdirSync(join(spec.cwd, "spec/acceptance"), { recursive: true });
    writeFileSync(join(spec.cwd, ACC_PATH), ACCEPTANCE_SPEC);
    return { output: { summary: "Abnahmetest geschrieben", acceptance_tests: [ACC_PATH], claims: [] } };
  };
  const implementerDep: Handler = async (spec) => {
    writeFileSync(join(spec.cwd, "src/rotation.lua"), FIXED_ROTATION);
    writeFileSync(join(spec.cwd, "package.json"), JSON.stringify({ name: "rotation", dependencies: { "left-pad": "1.3.0" } }, null, 2) + "\n");
    return { output: { summary: "Fix plus left-pad", changed_files: ["src/rotation.lua", "package.json"], claims: [] } };
  };
  const implementerAdr: Handler = async (spec) => {
    createAdr(join(spec.cwd, "docs/adr"), "left-pad aufnehmen", "2026-11-18");
    return { output: { summary: "ADR ergaenzt", changed_files: ["docs/adr/0001-left-pad-aufnehmen.md"], claims: [] } };
  };
  const approve: Handler = async () => ({ output: { verdict: "approve", summary: "ok", findings: [], claims: [] } });

  test("ADR-Befund geht vor den Sitzen in die Rückmeldung und blockiert", async () => {
    const project = setupProject();
    const home = tempHome();
    const store = openStore(join(home, "usac.db"));
    const runner = new ScriptedRunner({ "test-engineer": testEngineerOk, implementer: [implementerDep, implementerAdr], "code-reviewer": approve, "security-reviewer": approve });
    const orch = createOrchestrator({ store, runner, pluginRoot: REPO_ROOT, home, approvals: { auto: ["h1", "h2"] }, graphify: false });
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x" });
    const result = await orch.run(wi.id);
    expect(result.status).toBe("done");

    const events = store.events({ traceId: wi.id });
    const adrEvents = events.filter((e) => e.type === "review.adr");
    expect(adrEvents.map((e) => (e.data as { findings: unknown[] }).findings.length)).toEqual([1, 0]);
    const changes = events.find((e) => e.type === "review.changes_requested");
    expect(changes?.data).toMatchObject({ seat: { role: "adr-check" } });

    const impl = runner.calls.filter((c) => c.role === "implementer");
    expect(impl).toHaveLength(2);
    expect(impl[1]!.prompt).toContain(ADR_TEXT);
    expect(impl[1]!.prompt).toContain(`(adr-check/rule_6) [high] ${ADR_TEXT}`);
  }, 90_000);
});
