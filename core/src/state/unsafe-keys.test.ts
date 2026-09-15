import { expect, it } from "vitest";
import { findUnsafeKey } from "./unsafe-keys.ts";

/** Only `JSON.parse` makes `__proto__` an own key; an object literal would set a prototype. */
const parse = (json: string): unknown => JSON.parse(json);

it("passes a file that carries no prototype-shaped key", () => {
  expect(findUnsafeKey(parse('{"schemaVersion":1,"attempts":[{"courseNumber":"89-110"}]}')))
    .toBeUndefined();
});

it("names a __proto__ key and where it sits", () => {
  expect(findUnsafeKey(parse('{"schemaVersion":1,"__proto__":{"admin":true}}'))).toEqual({
    key: "__proto__",
    at: "",
  });
});

it("names a constructor key nested inside an array", () => {
  const file = parse('{"timetables":[{"variants":[{"constructor":{}}]}]}');

  expect(findUnsafeKey(file)).toEqual({
    key: "constructor",
    at: "timetables[0].variants[0]",
  });
});

it("names a prototype key", () => {
  expect(findUnsafeKey(parse('{"settings":{"prototype":1}}'))).toEqual({
    key: "prototype",
    at: "settings",
  });
});

it("does not mistake a string value for a key", () => {
  expect(findUnsafeKey(parse('{"attempts":[{"courseNumber":"__proto__"}]}'))).toBeUndefined();
});
