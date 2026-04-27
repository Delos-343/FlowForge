/**
 * FlowForge DAG types and validator (shared between client + executor).
 */
import { z } from "zod";

export const RetryPolicySchema = z.object({
  max_attempts: z.number().int().min(1).max(10).default(1),
  backoff_ms: z.number().int().min(0).max(60_000).default(1000),
  multiplier: z.number().min(1).max(10).default(2),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

const HttpStep = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
  headers: z.record(z.string()).optional(),
  body: z.any().optional(),
  expect_status: z.number().int().optional(),
});

const DelayStep = z.object({
  type: z.literal("delay"),
  ms: z.number().int().min(0).max(60_000),
});

const ScriptStep = z.object({
  type: z.literal("script"),
  // Sandboxed expression evaluator — no eval. e.g. "{{ steps.fetch.body.id }}"
  expression: z.string().max(2000),
});

const ConditionStep = z.object({
  type: z.literal("condition"),
  // Truthy expression on prior step outputs — e.g. "{{ steps.fetch.status }} == 200"
  expression: z.string().max(2000),
  on_true: z.string(), // next node id
  on_false: z.string().optional(),
});

export const StepSchema = z.discriminatedUnion("type", [
  HttpStep,
  DelayStep,
  ScriptStep,
  ConditionStep,
]);
export type Step = z.infer<typeof StepSchema>;

export const NodeSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(120),
  step: StepSchema,
  retry: RetryPolicySchema.optional(),
});
export type DagNode = z.infer<typeof NodeSchema>;

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type DagEdge = z.infer<typeof EdgeSchema>;

export const DagSchema = z
  .object({
    nodes: z.array(NodeSchema).min(1).max(50),
    edges: z.array(EdgeSchema).max(200).default([]),
    timeout_ms: z.number().int().min(1000).max(300_000).default(60_000),
  })
  .superRefine((dag, ctx) => {
    const ids = new Set<string>();
    for (const n of dag.nodes) {
      if (ids.has(n.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate node id: ${n.id}` });
      }
      ids.add(n.id);
    }
    for (const e of dag.edges) {
      if (!ids.has(e.from)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `edge from unknown node: ${e.from}` });
      if (!ids.has(e.to)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `edge to unknown node: ${e.to}` });
    }
    // Cycle detection via Kahn's
    if (hasCycle(dag.nodes, dag.edges)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "graph contains a cycle (must be a DAG)" });
    }
  });

export type Dag = z.infer<typeof DagSchema>;

function hasCycle(nodes: DagNode[], edges: DagEdge[]): boolean {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const q: string[] = [];
  for (const [k, v] of indeg) if (v === 0) q.push(k);
  let visited = 0;
  while (q.length) {
    const n = q.shift()!;
    visited++;
    for (const m of adj.get(n) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if (indeg.get(m) === 0) q.push(m);
    }
  }
  return visited !== nodes.length;
}

/** Topological sort returning execution layers (each layer can run in parallel). */
export function topoLayers(dag: Dag): string[][] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of dag.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of dag.edges) {
    adj.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const layers: string[][] = [];
  let frontier = [...indeg.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  while (frontier.length) {
    layers.push(frontier);
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        indeg.set(m, (indeg.get(m) ?? 0) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
    }
    frontier = next;
  }
  return layers;
}
