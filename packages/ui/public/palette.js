// Command-Palette: Meta+K bzw. Ctrl+K oeffnet, Escape schliesst. Befehle kommen aus /api/palette.
// Die Palette oeffnet nur Seiten. Freigaben werden hier nie erteilt (kein action-Aufruf, nur Navigation).
(function () {
  "use strict";

  var STYLE =
    ":root{--pal-bg:#fff;--pal-text:#1a1a1a;--pal-sel:#dbe8f7;--pal-border:#c8c8c8}" +
    "@media (prefers-color-scheme: dark){:root:not([data-theme=\"light\"]){--pal-bg:#1c1c1c;--pal-text:#eee;--pal-sel:#2c4a6b;--pal-border:#555}}" +
    ":root[data-theme=\"dark\"]{--pal-bg:#1c1c1c;--pal-text:#eee;--pal-sel:#2c4a6b;--pal-border:#555}" +
    "#usac-palette{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 0;z-index:1000}" +
    "#usac-palette[hidden]{display:none}" +
    "#usac-palette .pal-box{background:var(--pal-bg);color:var(--pal-text);border:1px solid var(--pal-border);border-radius:8px;width:100%;max-width:560px;max-height:70vh;display:flex;flex-direction:column;overflow:hidden}" +
    "#usac-palette input{font:inherit;padding:12px;border:0;border-bottom:1px solid var(--pal-border);background:transparent;color:inherit}" +
    "#usac-palette ul{list-style:none;margin:0;padding:0;overflow:auto}" +
    "#usac-palette li{padding:8px 12px;cursor:pointer}" +
    "#usac-palette li[aria-selected=\"true\"]{background:var(--pal-sel)}" +
    "#usac-palette .pal-empty{padding:12px;opacity:.7}";

  var overlay = null;
  var input = null;
  var list = null;
  var commands = [];
  var visible = [];
  var selected = 0;
  var lastFocus = null;

  function ensureDom() {
    if (overlay) return;
    var style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    overlay = document.createElement("div");
    overlay.id = "usac-palette";
    overlay.hidden = true;

    var box = document.createElement("div");
    box.className = "pal-box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Befehlspalette");

    input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Befehl oder Seite suchen";
    input.setAttribute("aria-label", "Befehl suchen");
    input.setAttribute("aria-controls", "usac-palette-list");
    input.setAttribute("autocomplete", "off");

    list = document.createElement("ul");
    list.id = "usac-palette-list";
    list.setAttribute("role", "listbox");

    box.appendChild(input);
    box.appendChild(list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    input.addEventListener("input", function () {
      selected = 0;
      filter();
    });
    input.addEventListener("keydown", onInputKey);
    // Fokus bleibt im Dialog: das einzige Bedienelement ist das Eingabefeld.
    box.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        input.focus();
      }
    });
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) close();
    });
  }

  function words(query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
  }

  function filter() {
    var raw = input.value.trim();
    var ws = words(raw);
    visible = commands.filter(function (c) {
      if (c.id === "memory-search") return raw.length > 0;
      var label = c.label.toLowerCase();
      return ws.every(function (w) {
        return label.indexOf(w) !== -1;
      });
    });
    visible = visible.map(function (c) {
      if (c.id !== "memory-search") return c;
      return { id: c.id, label: "Memory nach „" + raw + "“ durchsuchen", href: "/knowledge?q=" + encodeURIComponent(raw) };
    });
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
    render();
  }

  function render() {
    list.textContent = "";
    if (!visible.length) {
      var empty = document.createElement("li");
      empty.className = "pal-empty";
      empty.setAttribute("role", "presentation");
      empty.textContent = "Keine Treffer";
      list.appendChild(empty);
      input.removeAttribute("aria-activedescendant");
      return;
    }
    visible.forEach(function (c, i) {
      var li = document.createElement("li");
      li.id = "usac-opt-" + i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === selected ? "true" : "false");
      li.textContent = c.label;
      li.addEventListener("click", function () {
        selected = i;
        run(i);
      });
      list.appendChild(li);
    });
    input.setAttribute("aria-activedescendant", "usac-opt-" + selected);
  }

  function move(delta) {
    if (!visible.length) return;
    selected = (selected + delta + visible.length) % visible.length;
    render();
    var el = document.getElementById("usac-opt-" + selected);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }

  function run(i) {
    var c = visible[i];
    if (!c || typeof c.href !== "string") return;
    // Nur lokale Pfade; Freigaben werden nie erteilt, nur ihre Review-Seite geoeffnet.
    if (c.href.charAt(0) !== "/" || c.href.charAt(1) === "/") return;
    window.location.href = c.href;
  }

  function onInputKey(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function isOpen() {
    return !!overlay && !overlay.hidden;
  }

  function open() {
    ensureDom();
    lastFocus = document.activeElement;
    overlay.hidden = false;
    input.value = "";
    selected = 0;
    input.focus();
    commands = [];
    visible = [];
    render();
    fetch("/api/palette", { headers: { accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : [];
      })
      .then(function (data) {
        commands = Array.isArray(data) ? data : [];
        if (isOpen()) filter();
      })
      .catch(function () {
        commands = [];
        if (isOpen()) filter();
      });
    filter();
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    lastFocus = null;
  }

  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (isOpen()) close();
      else open();
      return;
    }
    if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      close();
    }
  });
})();
