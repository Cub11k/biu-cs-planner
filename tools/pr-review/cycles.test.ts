import { describe, expect, it } from "vitest";
import type { CallEdge } from "../pr-report/calls.ts";
import type { Module } from "../pr-report/surface.ts";
import { callCycles, findCycles, moduleCycles } from "./cycles.ts";

const graph = (entries: Record<string, string[]>): Map<string, string[]> =>
  new Map(Object.entries(entries));

const module = (path: string, imports: string[]): Module => ({
  path,
  workspace: path.split("/")[0] ?? "",
  exports: [],
  imports,
  packages: [],
});

describe("findCycles", () => {
  it("finds nothing in a graph that is already a DAG", () => {
    expect(findCycles(graph({ a: ["b", "c"], b: ["c"], c: [] }))).toEqual([]);
  });

  it("reports a two-node cycle as a path that returns to where it started", () => {
    expect(findCycles(graph({ a: ["b"], b: ["a"] }))).toEqual([["a", "b", "a"]]);
  });

  it("reports a node that depends on itself", () => {
    expect(findCycles(graph({ a: ["a"] }))).toEqual([["a", "a"]]);
  });

  it("reports the whole loop, not just the edge that closed it", () => {
    expect(findCycles(graph({ a: ["b"], b: ["c"], c: ["a"] }))).toEqual([
      ["a", "b", "c", "a"],
    ]);
  });

  it("leaves the tail out of the path when the cycle starts partway in", () => {
    // `a` only leads to the loop; it is not part of it.
    expect(findCycles(graph({ a: ["b"], b: ["c"], c: ["b"] }))).toEqual([
      ["b", "c", "b"],
    ]);
  });

  it("reports one loop once, however many ways in there are", () => {
    const cycles = findCycles(graph({ start: ["a"], other: ["b"], a: ["b"], b: ["a"] }));
    expect(cycles).toEqual([["a", "b", "a"]]);
  });

  it("reports two independent loops separately", () => {
    expect(findCycles(graph({ a: ["b"], b: ["a"], x: ["y"], y: ["x"] }))).toEqual([
      ["a", "b", "a"],
      ["x", "y", "x"],
    ]);
  });

  it("tolerates an edge to a node the graph never declares", () => {
    expect(findCycles(graph({ a: ["missing"] }))).toEqual([]);
  });
});

describe("moduleCycles", () => {
  it("says nothing about layers that only point downwards", () => {
    expect(
      moduleCycles([
        module("app/src/use.ts", ["core/src/plan.ts"]),
        module("core/src/plan.ts", []),
      ]),
    ).toEqual([]);
  });

  it("catches a back edge from a lower layer to a higher one", () => {
    expect(
      moduleCycles([
        module("app/src/use.ts", ["core/src/plan.ts"]),
        module("core/src/plan.ts", ["app/src/use.ts"]),
      ]),
    ).toEqual([["app/src/use.ts", "core/src/plan.ts", "app/src/use.ts"]]);
  });

  it("ignores imports that are not modules of this project", () => {
    expect(moduleCycles([module("core/src/plan.ts", ["zod", "node:fs"])])).toEqual([]);
  });
});

describe("callCycles", () => {
  const edge = (from: string, to: string): CallEdge => ({ from, to });

  it("says nothing about calls that only go one way", () => {
    expect(callCycles([edge("core/src/a.ts#f", "core/src/b.ts#g")])).toEqual([]);
  });

  it("names the modules a mutual call spans", () => {
    expect(
      callCycles([
        edge("core/src/a.ts#f", "core/src/b.ts#g"),
        edge("core/src/b.ts#g", "core/src/a.ts#f"),
      ]),
    ).toEqual([
      {
        path: ["core/src/a.ts#f", "core/src/b.ts#g", "core/src/a.ts#f"],
        modules: ["core/src/a.ts", "core/src/b.ts"],
      },
    ]);
  });

  it("names each module once when a loop passes through three of them", () => {
    const cycle = callCycles([
      edge("a.ts#f", "b.ts#g"),
      edge("b.ts#g", "c.ts#h"),
      edge("c.ts#h", "a.ts#f"),
    ]);
    expect(cycle[0]?.modules).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
