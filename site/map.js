// The map's drawing rules, from assets/dashboard.html, for the website's drawings: the same
// strokes, stations, labels and bevelled branch corners, so the site draws exactly as the app does.

const NS = "http://www.w3.org/2000/svg";

export const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  node.append(...kids);
  return node;
};

const ctx = document.createElement("canvas").getContext("2d");
export const measure = (text, font, spacing = 0) => {
  ctx.font = font;
  return ctx.measureText(text).width + spacing * text.length;
};
const FONT = { name: "14px Geist, system-ui", tag: "500 9.5px Geist, system-ui", small: "500 11px Geist, system-ui" };

export const T = "var(--track)";
export const SOFT = "var(--track-soft)";
export const AMBER = "var(--amber)";
export const RED = "var(--red)";
export const HERE = [["you are here", "var(--accent)"]];

// Undashed lines draw in when their map is shown; dashed ones (merged branches) just appear.
export const path = (d, stroke, width, dash) => el("path", { d, stroke, "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none", "stroke-dasharray": dash || null, class: dash ? null : "ln" });
export const station = (cx, cy, stroke) => el("circle", { cx, cy, r: 5, fill: "var(--shell)", stroke, "stroke-width": 3, class: "mk" });
export const depot = (cx, cy, stroke) => el("rect", { x: cx - 5.5, y: cy - 5.5, width: 11, height: 11, rx: 3, fill: "var(--shell)", stroke, "stroke-width": 3, class: "mk" });
export const interchange = (cx, cy) => el("rect", { x: cx - 13, y: cy - 7.5, width: 26, height: 15, rx: 7.5, fill: "var(--shell)", stroke: T, "stroke-width": 3, class: "mk" });
export const commit = (cx, cy) => el("circle", { cx, cy, r: 4, fill: T, class: "mk" });
export const youAreHere = (cx, cy) => el("g", { class: "mk" },
  el("circle", { cx, cy, r: 11, fill: "var(--accent)", opacity: 0.14 }),
  el("circle", { cx, cy, r: 5.5, fill: "var(--accent)", stroke: "var(--shell)", "stroke-width": 2 }));
export const badge = (cx, cy, text, fill, ink) => {
  const w = measure(text, FONT.small) + 14;
  return el("g", { class: "mk" },
    el("rect", { x: cx - w / 2, y: cy - 9, width: w, height: 18, rx: 9, fill }),
    el("text", { x: cx, y: cy + 4, "text-anchor": "middle", "font-size": 11, "font-weight": 500, "font-family": "var(--font)", fill: ink }, text));
};
export const counter = (cx, cy, n, stroke, dashed) => {
  const text = String(n);
  const w = Math.max(20, measure(text, FONT.small) + 12);
  return el("g", { class: "mk" },
    el("rect", { x: cx - w / 2, y: cy - 9, width: w, height: 18, rx: 9, fill: "var(--shell)", stroke, "stroke-width": 2.5, "stroke-dasharray": dashed ? "0.5 4" : null, "stroke-linecap": "round" }),
    el("text", { x: cx, y: cy + 4, "text-anchor": "middle", "font-size": 11, "font-weight": 500, "font-family": "var(--font)", fill: "var(--text-2)" }, text));
};

// A branch or group's name, its tags, and a note underneath, placed right of its terminus.
export const label = (x, y, title, note, noteColor, tags = []) => {
  const g = el("g", {});
  const name = el("text", { x, y: y - 3, "font-size": 14, "font-family": "var(--font)", fill: "var(--text)" });
  const slash = title.lastIndexOf("/");
  // Quiet the namespace (feat/, fix/) so the part that names the work leads.
  if (slash > 0 && !title.startsWith("origin/")) name.append(el("tspan", { fill: "var(--text-3)" }, title.slice(0, slash + 1)), el("tspan", {}, title.slice(slash + 1)));
  else name.textContent = title;
  g.append(name);
  let tx = x + measure(title, FONT.name) + 10;
  for (const [t, color] of tags) {
    g.append(el("text", { x: tx, y: y - 4, "font-size": 9.5, "font-weight": 500, "font-family": "var(--font)", "letter-spacing": "0.08em", fill: color }, t.toUpperCase()));
    tx += measure(t.toUpperCase(), FONT.tag, 0.8) + 10;
  }
  g.append(el("text", { x, y: y + 14, "font-size": 12.5, "font-family": "var(--font)", fill: noteColor || "var(--text-3)", class: "note" }, note));
  return g;
};

// A branch leaves main with the map's bevelled corners and runs to the terminus column.
export const branchPath = (fx, mainY, y, termX) => `M${fx} ${mainY}l10 10V${y - 10}l10 10H${termX}`;

export const legend = (items) => {
  const ul = document.createElement("ul");
  ul.className = "legend";
  for (const [text, draw] of items) {
    const s = el("svg", { width: 22, height: 12, viewBox: "0 0 22 12", "aria-hidden": "true" });
    draw(s);
    const li = document.createElement("li");
    li.append(s, text);
    ul.append(li);
  }
  return ul;
};

// Readies a drawn map to draw itself in: each line its length, each mark its turn.
export const stagger = (box, lineStep = 90, markStart = 250, markStep = 70) => {
  box.querySelectorAll(".ln").forEach((p, i) => {
    p.style.setProperty("--len", String(Math.ceil(p.getTotalLength())));
    p.style.setProperty("--d", `${i * lineStep}ms`);
  });
  box.querySelectorAll(".mk").forEach((m, i) => m.style.setProperty("--d", `${markStart + i * markStep}ms`));
};
