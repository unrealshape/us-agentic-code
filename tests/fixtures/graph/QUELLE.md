# Herkunft von `graph.json`

Beleg für das Graph-Format (Regel 2, offene Frage „Graph-Format“ in ADR 0006).

- **Werkzeug:** graphify 0.9.65 (`graphify --version`), Python-Paket unter Windows 11 (Git Bash). Kein Lauf unter Linux/WSL2; das Format ist plattformunabhängiges JSON, die Pfade in `source_file` stehen mit `/`.
- **Datum:** 2026-11-18
- **Befehl:** in einer Kopie von `tests/fixtures/lua-rotation`: `graphify update .`
  (Ausgabe: `Rebuilt: 4 nodes, 2 edges, 2 communities`)
- **Datei:** `graphify-out/graph.json` unverändert übernommen (4 Knoten, also unter der Grenze von 30; keine Kürzung nötig).

## Feldnamen eines Knotens (`nodes[]`)

| Bedeutung   | Feld              | Beispiel                       |
|-------------|-------------------|--------------------------------|
| Knoten-ID   | `id`              | `src_rotation_m_next_spell`    |
| Label       | `label`           | `M.next_spell()`               |
| Quelldatei  | `source_file`     | `src/rotation.lua` (relativ zum Projekt) |
| Zeile       | `source_location` | `L6` (Text mit Präfix `L`)     |

Beobachtungen:

- Externe Knoten (z. B. ein Import `rotation`) haben `source_file: ""` und kein `source_location`. `loadGraph` lässt Knoten ohne Quelldatei weg.
- Kanten stehen unter `links[]` (`source`, `target`, `relation`); dort ist `source_location` teils ohne Präfix (`"1"`). `loadGraph` liest keine Kanten.
- Weitere Knotenfelder (`community`, `community_name`, `file_type`, `norm_label`, `_origin`, `_callable`) werden nicht ausgewertet.
