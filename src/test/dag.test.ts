import { describe, it, expect } from "vitest";
import { DagSchema, topoLayers, type Dag } from "../lib/dag";

const baseNode = (id: string) => ({
  id,
  name: id,
  step: { type: "delay" as const, ms: 1 },
});

describe("DagSchema", () => {
  it("accepts a valid linear DAG", () => {
    const dag = {
      nodes: [baseNode("a"), baseNode("b"), baseNode("c")],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
    };
    expect(DagSchema.parse(dag)).toBeTruthy();
  });

  it("rejects duplicate node ids", () => {
    const dag = { nodes: [baseNode("a"), baseNode("a")], edges: [] };
    expect(() => DagSchema.parse(dag)).toThrow(/duplicate node/);
  });

  it("rejects edges referencing unknown nodes", () => {
    const dag = { nodes: [baseNode("a")], edges: [{ from: "a", to: "ghost" }] };
    expect(() => DagSchema.parse(dag)).toThrow(/unknown node/);
  });

  it("rejects cycles", () => {
    const dag = {
      nodes: [baseNode("a"), baseNode("b")],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    };
    expect(() => DagSchema.parse(dag)).toThrow(/cycle/);
  });

  it("rejects invalid step types", () => {
    const dag = {
      nodes: [{ id: "a", name: "a", step: { type: "rocket", payload: {} } }],
      edges: [],
    };
    expect(() => DagSchema.parse(dag)).toThrow();
  });

  it("validates http url", () => {
    const dag = {
      nodes: [{ id: "h", name: "h", step: { type: "http", url: "not-a-url" } }],
      edges: [],
    };
    expect(() => DagSchema.parse(dag)).toThrow();
  });
});

describe("topoLayers", () => {
  it("groups independent nodes into the same layer", () => {
    const dag: Dag = DagSchema.parse({
      nodes: ["a", "b", "c", "d"].map(baseNode),
      edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
      ],
    });
    const layers = topoLayers(dag);
    expect(layers).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  it("returns a single layer for fully independent nodes", () => {
    const dag: Dag = DagSchema.parse({
      nodes: ["a", "b", "c"].map(baseNode),
      edges: [],
    });
    expect(topoLayers(dag)).toEqual([["a", "b", "c"]]);
  });

  it("handles a single node", () => {
    const dag: Dag = DagSchema.parse({ nodes: [baseNode("only")], edges: [] });
    expect(topoLayers(dag)).toEqual([["only"]]);
  });
});
