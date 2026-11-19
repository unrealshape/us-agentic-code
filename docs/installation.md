# Installation

Diese Anleitung beschreibt die Einrichtung für Windows (nativ, ohne WSL2) und Linux/WSL2. Die Schritte für Windows sind auf diesem PC geprüft. Was nur unter Linux oder WSL2 läuft, ist als solches markiert.

Der Befehl `usac doctor` prüft am Ende, was fehlt. Pflicht-Werkzeuge müssen `ok` zeigen. Mit `--` markierte Werkzeuge sind optional.

## 1. Windows (nativ)

### Pflicht-Werkzeuge

| Werkzeug | Installation | Prüfen |
|---|---|---|
| Bun | `irm https://bun.sh/install.ps1 \| iex` (PowerShell) | `bun --version` |
| Git | `winget install Git.Git` | `git --version` |
| Claude Code | gemäß offizieller Doku, Anmeldung über das Abo | `claude --version` |
| Python 3.10+ | `winget install Python.Python.3.14` | `python --version` |
| graphify | `pip install graphifyy` | `graphify --help` |

Hinweis zu Python: Der Doctor sucht den Befehl `python3`. Auf Windows liefert `python3` ohne Installation nur einen Store-Platzhalter, der nicht funktioniert. Nach der Installation von Python liegt `python.exe` in `%LOCALAPPDATA%\Programs\Python\Python314\`. Dort eine Kopie `python3.exe` anlegen:

```powershell
Copy-Item "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe" "$env:LOCALAPPDATA\Programs\Python\Python314\python3.exe"
```

Ein `.cmd`-Shim reicht nicht, weil Git Bash und Bun nur `.exe` zuverlässig finden.

### Lua-Werkzeuge (Gate-Profil Lua)

```powershell
winget install --id DEVCOM.Lua -e          # lua + luarocks
winget install --id JohnnyMorganz.StyLua -e
winget install --id LuaLS.lua-language-server -e
```

`busted` lässt sich unter Windows nur bauen, wenn ein C-Compiler vorhanden ist (`luasystem` ist ein C-Modul). Ohne Compiler scheitert `luarocks install busted`.

```powershell
winget install --id MSYS2.MSYS2 -e
# In der MSYS2-Shell (C:\msys64\ucrt64.exe):
pacman -S --noconfirm mingw-w64-ucrt-x86_64-gcc
```

Danach busted über luarocks installieren. Die Aufrufe müssen mit dem gcc aus MSYS2 im PATH laufen:

```bash
export PATH="/c/msys64/ucrt64/bin:$PATH"
luarocks install busted
```

Damit `busted` seine Module findet, setzt du die Lua-Pfade als Umgebungsvariablen (Benutzerebene, PowerShell):

```powershell
[Environment]::SetEnvironmentVariable("LUA_PATH", "C:/Users/<name>/.luarocks/share/lua/5.4/?.lua;C:/Users/<name>/.luarocks/share/lua/5.4/?/init.lua;;", "User")
[Environment]::SetEnvironmentVariable("LUA_CPATH", "C:/Users/<name>/.luarocks/lib/lua/5.4/?.dll;;", "User")
```

Die genauen Pfade zeigt `luarocks path` an. Außerdem müssen `C:\Users\<name>\.luarocks\bin`, `C:\msys64\ucrt64\bin` und der Lua-Ordner im Benutzer-PATH stehen.

Prüfen: `busted --version` muss `2.x` ausgeben.

### Optional

- GitHub CLI: `winget install GitHub.cli`, danach `gh auth login`.
- Headless-Anmeldung für Hintergrundläufe: `claude setup-token` und `CLAUDE_CODE_OAUTH_TOKEN` setzen. Ohne Token funktioniert die Anmeldung über das Abo, sofern Claude Code interaktiv angemeldet ist. Ob Hintergrundläufe des Daemons ohne Token zuverlässig laufen, ist noch nicht geprüft (siehe ADR 0001).

### Nicht unter Windows nativ

- **Sandbox (bubblewrap, socat):** läuft nur unter Linux. Der Doctor zeigt die beiden Zeilen unter Windows als optional. Für die Sandbox-Prüfung ist WSL2 nötig (Abschnitt 2).
- **Die Test-Fixtures** (`tests/fixtures/fake-claude.ts` mit Shebang, Bash-Skript `claude` in den Unit-Tests) starten unter Windows nicht direkt. Die Folge sind 10 rote Tests (`uv_spawn EFTYPE`). Diese Tests laufen unter WSL2.

## 2. Linux oder WSL2

WSL2 ist die vorgesehene Plattform für Sandbox und vollständige Tests. **Ungeprüft:** Die Schritte unten sind nicht auf diesem PC ausgeführt worden. Vor dem Vertrauen prüfen (`bubblewrap`, `socat`, `busted`-Paket und `lua5.4`-Paketname auf der jeweiligen Distribution).

Windows als Administrator:

```powershell
wsl --install
```

Danach neu starten, Benutzer in Ubuntu anlegen und dort:

```bash
sudo apt update
sudo apt install -y bubblewrap socat lua5.4 luarocks git python3
sudo luarocks install busted
sudo luarocks install luacheck
curl -fsSL https://bun.sh/install | bash
```

Claude Code und graphify installieren wie unter Abschnitt 1, im WSL-Terminal.

## 3. Projekt einrichten

```bash
bun install
bun test                       # alle Tests, Pflicht vor Commit
bunx tsc -p tsconfig.json --noEmit
bun packages/daemon/src/cli.ts doctor
```

## 4. Als Claude-Code-Plugin installieren

Das Repo ist gleichzeitig ein Plugin-Marketplace (`.claude-plugin/marketplace.json`) mit dem Plugin `usac`. Prüfen mit `claude plugin validate .` (Stand: bestanden, mit Hinweisen zu Icon und Netzwerk-Hosts).

**Variante A: aus dem lokalen Ordner** (sofort möglich, nimmt den Stand, den du ausgecheckt hast):

```powershell
claude plugin marketplace add C:\Users\<name>\Desktop\dev\us-agentic-code-phase1
claude plugin install usac@us-agentic-code
```

**Variante B: direkt von GitHub** (`unrealshape/us-agentic-code`). Der Branch `main` enthält den aktuellen Stand noch nicht, er liegt auf `feature/phase-1`. Eine Syntax für Branches ist mit `claude plugin marketplace add --help` nicht belegt. Deshalb vorerst Variante A oder Variante B nach dem Merge in `main`:

```powershell
claude plugin marketplace add unrealshape/us-agentic-code
claude plugin install usac@us-agentic-code
```

Danach in Claude Code `/plugin` aufrufen und prüfen, dass `usac` aktiv ist. Ein Icon ist noch nicht hinterlegt (Hinweis `ICON_MISSING`, nur für den Plugin-Katalog relevant).

## Fehlersuche

| Symptom | Ursache | Abhilfe |
|---|---|---|
| `Python was not found; run without arguments to install from the Microsoft Store` | Store-Alias `python3` in `WindowsApps` fängt den Befehl ab | Abschnitt 1, `python3.exe` anlegen |
| `bun` läuft nicht, obwohl installiert | Ein alter npm-Shim (`npm i -g bun`) liegt vor dem Installer-Pfad im PATH | `npm uninstall -g bun`, dann `C:\Users\<name>\.bun\bin` in den Benutzer-PATH |
| `module 'busted.runner' not found` | `LUA_PATH` fehlt oder zeigt nicht auf den luarocks-Ordner | Abschnitt 1, Lua-Pfade setzen |
| `gcc: command not found` beim luarocks-Build | kein C-Compiler | MSYS2 mit `mingw-w64-ucrt-x86_64-gcc` |
| `uv_spawn EFTYPE` in den Tests | Fixture wird direkt gestartet, Windows führt Shebang nicht aus | Tests unter WSL2 ausführen |
| Abnahmetest wird als „verändert“ verworfen, obwohl niemand ihn geändert hat | Git schreibt unter Windows CRLF (`core.autocrlf=true`), Hash weicht ab | behoben in `packages/daemon/src/exec.ts` (`git -c core.autocrlf=false`) |
| Dateien verschwinden nach Installation | Virenscanner hat Werkzeuge gelöscht | Ausnahme für `C:\Users\<name>\.bun`, `...\Python314`, `C:\msys64`, `...\.luarocks` im Scanner setzen |
