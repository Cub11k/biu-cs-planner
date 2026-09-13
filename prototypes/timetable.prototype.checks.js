/* Headless checks for timetable.prototype.html — throwaway, like the prototype itself.
   This environment has no browser automation, so these read the rendered markup instead of
   pixels: they catch broken state, not ugly spacing.
   Run: node timetable.prototype.checks.js   (any Node >= 18) */

const fs = require("fs"), path = require("path"), os = require("os");
const html = fs.readFileSync(path.join(__dirname, "timetable.prototype.html"), "utf8");
const css = html.split("</style>")[0];
const script = html.split("<script>")[1].split("</script>")[0];

const stub = `const root = { lang: "", dir: "ltr", dataset: {} };
const el = () => ({ innerHTML: "", style: {}, textContent: "", appendChild(){}, remove(){} });
globalThis.document = { documentElement: root, body: { appendChild(){} },
  getElementById: () => el(), createElement: () => el(), addEventListener(){} };
globalThis.history = { replaceState(){} };
globalThis.location = { href: "http://x/y.html", search: "" };
`;
const expose = `
globalThis.X = { LAYOUTS, state, clashes, examRows, weekHTML, togglePick, pickedCredits,
  completeness, course, examRailHTML, candidateClashes, switcherHTML, render, THEMES, root };
`;
const srcFile = path.join(os.tmpdir(), "proto-checks-src.js");
fs.writeFileSync(srcFile, stub + script + expose);
require(srcFile);

const { LAYOUTS, state, clashes, examRows, weekHTML, pickedCredits, completeness, course,
        examRailHTML, candidateClashes, switcherHTML, render, root } = globalThis.X;

let fails = 0;
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const count = (s, re) => (s.match(re) || []).length;
const idx = (s, t) => s.indexOf(t);

/* --- every layout still renders, in both languages --- */
ok(Object.keys(LAYOUTS).join("") === "EFDABC", `layouts: ${Object.keys(LAYOUTS).join(", ")}`);
ok(state.layout === "E", "E, the agreed layout, is the default");
for (const lang of ["en", "he"]) {
  state.lang = lang;
  for (const k of Object.keys(LAYOUTS)) {
    let out = "";
    try { out = LAYOUTS[k].render(); } catch (e) { console.log(`THREW ${k}/${lang}: ${e.message}`); fails++; continue; }
    ok(out.length > 2000 && !/undefined|NaN/.test(out), `${k}/${lang} renders clean (${out.length} chars)`);
  }
}
state.lang = "en";

/* --- the agreed screen's shape --- */
state.selected = "89-110";
const e = LAYOUTS.E.render();
ok(idx(e, 'class="drawer"') < idx(e, 'class="gridwrap"'), "group drawer sits above the week");
ok(/class="examrail"/.test(e) && /class="vtl"/.test(e), "side pane holds the vertical exam rail");
ok(/class="clashstrip"/.test(e), "clashes sit in a strip above the week");
ok(count(e, /class="trayacts"/g) === 2, "plan differences carry their actions on the tray");
ok(/class="tabs"/.test(e) && /data-tt="main"/.test(e), "Main/Backup tabs are present");
ok(count(css, /\n  \.tabs \{/g) === 1 && !/\.D \.tabs \{/.test(css), "tab styling is shared, as it was in A");
ok(count(examRailHTML(), /class="ex /g) === 10 && count(examRailHTML(), /tight/g) === 4,
   "exam rail draws ten exams and marks four tight gaps");

/* --- tiles --- */
const w = weekHTML({ ghostFor: "89-110", loud: true, hour: 66 });
ok(count(w, /class="nm"/g) === 12, `every picked tile names its course (${count(w, /class="nm"/g)})`);
ok(/class="nm">Introduction to Computer Science<\/div><div class="sub">89-110 · Lecture 01 · 10:00–12:00<\/div>/.test(w),
   "tile reads name, then number, lesson type, group, times");
ok(count(w, /class="blk ghost/g) === 4, "pencil options for the selected course");
ok(count(w, /class="blk pick clash/g) === 3, "three meetings marked in red pen");
ok(count(w, /class="blk busy/g) === 2, "blocked times hatched out");
state.lang = "he";
ok(/class="nm">מבוא למדעי המחשב</.test(weekHTML({ ghostFor: "89-110", loud: true, hour: 66 })), "Hebrew name on the tile");
state.lang = "en";
ok(count(weekHTML({ compact: true, previewOnly: true }), /class="nm"/g) === 0, "the small preview grid stays number-only");

/* --- a previewed group must not look safe when it clashes --- */
state.preview = { courseId: "89-133", groupId: "01" };
ok(candidateClashes(course("89-133"), course("89-133").groups[0]).length > 0, "89-133 lecture 01 does clash with blocked work time");
ok(count(weekHTML({ ghostFor: "89-133", loud: true }), /class="blk preview clash"/g) > 0, "previewed clashing group keeps red-pen styling");
state.preview = { courseId: "89-110", groupId: "13" };
const free = weekHTML({ ghostFor: "89-110", loud: true });
ok(count(free, /class="blk preview"/g) > 0 && count(free, /class="blk preview clash"/g) === 0, "previewed free group stays plain");
state.preview = null;

/* --- domain results --- */
ok(clashes().length === 2, `two seeded clashes: ${clashes().map(c => c.a.c.id + " × " + (c.kind === "blocked" ? c.blocked.label.en : c.b.c.id)).join(" | ")}`);
ok(examRows().length === 10 && examRows().filter(r => r.tight).length === 4, "ten exams, four tight gaps");
ok(pickedCredits() === 23, `credits picked: ${pickedCredits()}`);
ok(completeness(course("89-132")).missing.join() === "tirgul", "89-132 reads as needing a tirgul");
state.tt = "backup";
ok(clashes().length === 0 && pickedCredits() === 5, "backup variant keeps its own picks");
state.tt = "main";

/* --- colour scheme --- */
ok(/@media \(prefers-color-scheme: dark\)/.test(css), "dark scheme follows the operating system");
ok(/:root\[data-theme="dark"\]/.test(css) && /:root:not\(\[data-theme="light"\]\)/.test(css),
   "an explicit choice overrides it in both directions");
ok(count(css, /:root\[data-theme="dark"\] \[data-type=/g) === 4, "every lesson type is re-toned for dark");
const noTokens = css.replace(/--[a-z0-9-]+\s*:[^;]+;/g, "");
const design = noTokens.replace(/\.(switcher|statepane)[^{]*\{[^}]*\}/g, "");
const stray = design.match(/(?:background|color|border[^:]*):[^;]*#[0-9a-fA-F]{3,6}/g) || [];
ok(stray.length === 0, `no raw colours left in the design's own rules (${stray.join(", ") || "none"})`);
state.theme = "system"; render();
ok(root.dataset.theme === undefined, "system theme leaves the root attribute off");
state.theme = "dark"; render();
ok(root.dataset.theme === "dark", "dark theme stamps the root attribute");
state.theme = "light"; render();
ok(root.dataset.theme === "light", "light theme stamps it too");
state.theme = "system"; render();
ok(/data-themestep/.test(switcherHTML()), "the theme button cannot be confused with the root attribute");

console.log(fails ? `\n${fails} failed` : `\nall ${count(fs.readFileSync(__filename, "utf8"), /\bok\(/g) - 1}+ checks passed`);
process.exit(fails ? 1 : 0);
