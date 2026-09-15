import { expect, it } from "vitest";
import { parseStateFile } from "./file.ts";
import { findUnsafeKey } from "./unsafe-keys.ts";

it("probe: non-object list entries", () => {
  const r = parseStateFile({ schemaVersion: 1, attempts: ["nope", 5, null] });
  console.log("A", JSON.stringify(r));
});

it("probe: variants entry is a string", () => {
  const r = parseStateFile({ schemaVersion: 1, timetables: [{ academicYear: 2027, semester: "fall", variants: ["x"] }] });
  console.log("B", JSON.stringify(r));
});

it("probe: array masquerading as object", () => {
  const arr: unknown = Object.assign([], { name: "v", picks: [] });
  const r = parseStateFile({ schemaVersion: 1, timetables: [{ academicYear: 2027, semester: "fall", variants: [arr] }] });
  console.log("C", JSON.stringify(r));
});

it("probe: settings is an array", () => {
  console.log("D", JSON.stringify(parseStateFile({ schemaVersion: 1, settings: [] })));
  console.log("D2", JSON.stringify(parseStateFile({ schemaVersion: 1, settings: "x" })));
  console.log("D3", JSON.stringify(parseStateFile({ schemaVersion: 1, settings: null })));
  console.log("D4", JSON.stringify(parseStateFile({ schemaVersion: 1, settings: 0 })));
});

it("probe: weird schemaVersions", () => {
  for (const v of [0.5, 1.5, -1, 1e999, "1"]) {
    console.log("E", JSON.stringify(v), JSON.stringify(parseStateFile({ schemaVersion: v })));
  }
  console.log("E-NaN", JSON.stringify(parseStateFile({ schemaVersion: NaN })));
});

it("probe: deep nesting", () => {
  let deep: unknown = 1;
  for (let i = 0; i < 20000; i++) deep = { a: deep };
  let threw = "no";
  try { parseStateFile({ schemaVersion: 1, attempts: deep }); } catch (e) { threw = String(e).slice(0, 80); }
  console.log("F", threw);
});

it("probe: getter that throws", () => {
  const hostile: Record<string, unknown> = { schemaVersion: 1 };
  Object.defineProperty(hostile, "attempts", { enumerable: true, get() { throw new Error("boom"); } });
  let threw = "no";
  try { parseStateFile(hostile); } catch (e) { threw = String(e).slice(0, 80); }
  console.log("G", threw);
});

it("probe: proto in a non-JSON object literal", () => {
  const lit = { schemaVersion: 1, settings: { ["__proto__"]: { isAdmin: true } } };
  console.log("H", JSON.stringify(parseStateFile(lit)), JSON.stringify(findUnsafeKey(lit)));
});

it("probe: cycle", () => {
  const cyc: Record<string, unknown> = { schemaVersion: 1 };
  cyc.self = cyc;
  let threw = "no";
  try { parseStateFile(cyc); } catch (e) { threw = String(e).slice(0, 80); }
  console.log("I", threw);
});

it("probe: statuses round trip via JSON", () => {
  for (const status of ["planned","registered","passed","failed","exempt","credited"]) {
    const r = parseStateFile(JSON.parse(JSON.stringify({ schemaVersion: 1, attempts: [{ courseNumber: "1", academicYear: 2027, semester: "fall", status }] })));
    console.log("J", status, r.state?.attempts.length, JSON.stringify(r.warnings));
  }
});

it("probe: timetables not an array at all / pins not array", () => {
  console.log("K", JSON.stringify(parseStateFile({ schemaVersion: 1, timetables: "x", pins: 3, attempts: {} })));
});

it("probe: blocked time with a non-string label etc", () => {
  console.log("L", JSON.stringify(parseStateFile({ schemaVersion: 1, timetables: [{ academicYear: 2027, semester: "fall", blockedTimes: "x" }] })));
});

it("probe: two timetables same year+semester", () => {
  const r = parseStateFile({ schemaVersion: 1, timetables: [{ academicYear: 2027, semester: "fall" }, { academicYear: 2027, semester: "fall" }] });
  console.log("M", JSON.stringify(r.warnings), r.state?.timetables.length);
});

it("probe: duplicate variant names / duplicate picks same lessonType", () => {
  const r = parseStateFile({ schemaVersion: 1, timetables: [{ academicYear: 2027, semester: "fall", variants: [
    { name: "a", primary: true, picks: [
      { courseNumber: "1", lessonType: "L", groupNumber: "01", meetings: [] },
      { courseNumber: "1", lessonType: "L", groupNumber: "02", meetings: [] },
    ] },
    { name: "a", primary: false, picks: [] },
  ] }] });
  console.log("N", JSON.stringify(r.warnings));
});

it("probe: end before start", () => {
  console.log("O", JSON.stringify(parseStateFile({ schemaVersion: 1, timetables: [{ academicYear: 2027, semester: "fall", blockedTimes: [{ semester: "fall", day: "sunday", start: "18:00", end: "08:00", label: "x" }] }] }).warnings));
});
