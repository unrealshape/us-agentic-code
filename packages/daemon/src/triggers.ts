import { matchesAny } from "./config";

/**
 * Security-Trigger: geaenderte Pfade (Glob) oder hinzugefuegte Diff-Zeilen, die einen
 * zweiten Review-Sitz durch den security-reviewer ausloesen. Reihenfolge ist fest.
 */
export interface SecurityTrigger {
  name: string;
  paths?: string[];
  added?: RegExp;
}

export const SECURITY_TRIGGERS: SecurityTrigger[] = [
  {
    name: "auth",
    paths: ["**/auth/**", "**/auth.*", "**/oauth/**", "**/login*", "**/logout*", "**/session*", "**/permission*", "**/acl/**"],
    added: /\b(authenticate|authorize|jwt|bearer|oauth|setPassword|checkPassword|verifyPassword)\b/i,
  },
  {
    name: "crypto",
    paths: ["**/crypto/**", "**/crypto.*"],
    added: /\b(createHash|createHmac|createCipheriv|createDecipheriv|createSign|createVerify|randomBytes|subtle\.|hashlib|bcrypt|scrypt|pbkdf2|argon2|md5|sha1|sha256|sha512)\b/i,
  },
  {
    name: "secrets",
    paths: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/secrets/**", "**/credentials*"],
    added: /\b[A-Z0-9_]*(API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\b\s*[:=]/,
  },
  {
    name: "sql",
    paths: ["**/*.sql", "**/migrations/**"],
    added: /\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i,
  },
  {
    name: "exec",
    added:
      /\b(child_process|execSync|execFile(Sync)?|spawn(Sync)?\s*\(|subprocess\.|os\.(system|popen|execute|exec\w*)\s*\(|io\.popen\s*\(|Bun\.spawn(Sync)?|eval\s*\(|Runtime\.getRuntime\(\)\.exec)/,
  },
  {
    name: "filesystem",
    added:
      /\b(fs\.(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|chmod|chmodSync|chown|chownSync|writeFile|writeFileSync|rename|renameSync)|rmSync|unlinkSync|shutil\.(rmtree|move|copy)|os\.(remove|unlink|rmdir|chmod|rename)\s*\()/,
  },
  {
    name: "network",
    added:
      /\b(fetch\s*\(|(axios|XMLHttpRequest|WebSocket|https?\.(request|get|createServer)|net\.(connect|createConnection|createServer|Socket)|requests\.(get|post|put|patch|delete)|urllib|socket\.(socket|connect|http)|curl|wget)\b)/,
  },
  {
    name: "dependencies",
    paths: [
      "**/package.json",
      "**/package-lock.json",
      "**/bun.lock",
      "**/bun.lockb",
      "**/yarn.lock",
      "**/pnpm-lock.yaml",
      "**/go.mod",
      "**/go.sum",
      "**/Cargo.toml",
      "**/Cargo.lock",
      "**/pyproject.toml",
      "**/requirements*.txt",
      "**/poetry.lock",
      "**/Pipfile",
      "**/Pipfile.lock",
      "**/pom.xml",
      "**/build.gradle",
      "**/build.gradle.kts",
      "**/Gemfile",
      "**/Gemfile.lock",
      "**/*.rockspec",
    ],
  },
  {
    name: "ci",
    paths: [".github/workflows/**", ".github/actions/**", ".gitlab-ci.yml", ".circleci/**", "**/Jenkinsfile", "azure-pipelines.yml"],
  },
];

/** Nur hinzugefuegte Diff-Zeilen (`+`), ohne Dateikopf (`+++`); das fuehrende `+` faellt weg. */
function addedLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/** Namen der ausgeloesten Trigger in der Reihenfolge von SECURITY_TRIGGERS. */
export function securityTriggers(changed: string[], diff: string): string[] {
  const added = addedLines(diff);
  return SECURITY_TRIGGERS.filter(
    (t) => (t.paths && changed.some((p) => matchesAny(p, t.paths!))) || (t.added && added.some((l) => t.added!.test(l))),
  ).map((t) => t.name);
}
