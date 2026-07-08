import { describe, it, expect } from "vitest";
import { DagSchema, NodeSchema, RetryPolicySchema, topoLayers, type Dag } from "../lib/dag";

const delay = (id: string, ms = 1) => ({
  id,
  name: id,
  step: { type: "delay" as const, ms },
});

describe("NodeSchema", () => {
  it("accepts hyphens/underscores in ids", () => {
    expect(NodeSchema.parse(delay("a_b-1"))).toBeTruthy();
  });

  it("rejects invalid id characters", () => {
    expect(() => NodeSchema.parse({ ...delay("a b"), id: "a b" })).toThrow();
    expect(() => NodeSchema.parse({ ...delay("bad."), id: "bad." })).toThrow();
  });

  it("caps id length at 64", () => {
    const long = "a".repeat(65);
    expect(() => NodeSchema.parse({ ...delay(long), id: long })).toThrow();
  });

  it("requires a non-empty name", () => {
    expect(() => NodeSchema.parse({ ...delay("a"), name: "" })).toThrow();
  });
});

describe("RetryPolicySchema", () => {
  it("fills defaults", () => {
    const p = RetryPolicySchema.parse({});
    expect(p).toEqual({ max_attempts: 1, backoff_ms: 1000, multiplier: 2 });
  });

  it("clamps max_attempts to [1,10]", () => {
    expect(() => RetryPolicySchema.parse({ max_attempts: 0 })).toThrow();
    expect(() => RetryPolicySchema.parse({ max_attempts: 11 })).toThrow();
  });

  it("clamps backoff_ms upper bound", () => {
    expect(() => RetryPolicySchema.parse({ backoff_ms: 60_001 })).toThrow();
  });
});

describe("DagSchema step types", () => {
  it("accepts a valid http step", () => {
    const dag = DagSchema.parse({
      nodes: [
        {
          id: "fetch",
          name: "fetch",
          step: {
            type: "http",
            url: "https://api.example.com/v1/x",
            method: "POST",
            headers: { "X-K": "v" },
            body: { a: 1 },
            expect_status: 200,
          },
        },
      ],
      edges: [],
    });
    expect(dag.nodes[0].step.type).toBe("http");
  });

  it("accepts a condition step", () => {
    const dag = DagSchema.parse({
      nodes: [
        { id: "c", name: "c", step: { type: "condition", expression: "1 == 1", on_true: "c" } },
      ],
      edges: [],
    });
    expect(dag.nodes[0].step.type).toBe("condition");
  });

  it("rejects an over-long script expression", () => {
    const long = "x".repeat(2001);
    expect(() =>
      DagSchema.parse({
        nodes: [{ id: "s", name: "s", step: { type: "script", expression: long } }],
        edges: [],
      }),
    ).toThrow();
  });

  it("rejects a self-loop as a cycle", () => {
    expect(() =>
      DagSchema.parse({ nodes: [delay("a")], edges: [{ from: "a", to: "a" }] }),
    ).toThrow(/cycle/);
  });

  it("rejects >50 nodes", () => {
    const nodes = Array.from({ length: 51 }, (_, i) => delay(`n${i}`));
    expect(() => DagSchema.parse({ nodes, edges: [] })).toThrow();
  });

  it("rejects a diamond with a back-edge", () => {
    expect(() =>
      DagSchema.parse({
        nodes: ["a", "b", "c", "d"].map((i) => delay(i)),
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "c" },
          { from: "b", to: "d" },
          { from: "c", to: "d" },
          { from: "d", to: "a" },
        ],
      }),
    ).toThrow(/cycle/);
  });
});

describe("topoLayers ordering", () => {
  it("handles a diamond dependency", () => {
    const dag: Dag = DagSchema.parse({
      nodes: ["a", "b", "c", "d"].map((i) => delay(i)),
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    });
    const layers = topoLayers(dag);
    expect(layers[0]).toEqual(["a"]);
    expect(layers[1].sort()).toEqual(["b", "c"]);
    expect(layers[2]).toEqual(["d"]);
  });

  it("returns an empty array for an empty node list", () => {
    const layers = topoLayers({ nodes: [], edges: [], timeout_ms: 1000 } as unknown as Dag);
    expect(layers).toEqual([]);
  });
});
