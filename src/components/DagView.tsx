import { useMemo } from "react";
import ReactFlow, { Background, Controls, MarkerType, Node, Edge } from "reactflow";
import "reactflow/dist/style.css";

export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped" | "retrying" | undefined;

interface Props {
  dag: { nodes: Array<{ id: string; name: string; step: { type: string } }>; edges: Array<{ from: string; to: string }> };
  statuses?: Record<string, StepStatus>;
  height?: number;
}

const statusColor: Record<string, string> = {
  running: "hsl(var(--warning))",
  success: "hsl(var(--success))",
  failed: "hsl(var(--destructive))",
  retrying: "hsl(var(--warning))",
  skipped: "hsl(var(--muted-foreground))",
};

export default function DagView({ dag, statuses = {}, height = 360 }: Props) {
  const { nodes, edges } = useMemo(() => {
    // Layered layout via simple BFS
    const indeg = new Map<string, number>();
    const adj = new Map<string, string[]>();
    dag.nodes.forEach(n => { indeg.set(n.id, 0); adj.set(n.id, []); });
    dag.edges.forEach(e => { adj.get(e.from)?.push(e.to); indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1); });
    const layers: string[][] = [];
    let frontier = [...indeg.entries()].filter(([, d]) => d === 0).map(([k]) => k);
    while (frontier.length) {
      layers.push(frontier);
      const next: string[] = [];
      for (const n of frontier) for (const m of adj.get(n) ?? []) {
        indeg.set(m, (indeg.get(m) ?? 0) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
      frontier = next;
    }
    const pos = new Map<string, { x: number; y: number }>();
    layers.forEach((layer, lx) => layer.forEach((id, idx) => {
      pos.set(id, { x: lx * 220, y: idx * 100 - (layer.length - 1) * 50 });
    }));
    const nodes: Node[] = dag.nodes.map(n => {
      const st = statuses[n.id];
      const color = st ? statusColor[st] : "hsl(var(--border))";
      return {
        id: n.id,
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        data: { label: (
          <div className="text-left">
            <div className="text-xs font-mono opacity-70">{n.step.type}</div>
            <div className="font-medium text-sm">{n.name}</div>
            {st && <div className="text-[10px] font-mono mt-1 uppercase tracking-wider" style={{ color }}>{st}</div>}
          </div>
        )},
        style: {
          background: "hsl(var(--card))",
          border: `1.5px solid ${color}`,
          color: "hsl(var(--foreground))",
          borderRadius: 8,
          padding: 10,
          minWidth: 160,
          boxShadow: st === "running" ? `0 0 20px ${color}` : "none",
        },
      };
    });
    const edges: Edge[] = dag.edges.map((e, i) => ({
      id: `e${i}`, source: e.from, target: e.to,
      animated: statuses[e.from] === "running" || statuses[e.to] === "running",
      style: { stroke: "hsl(var(--muted-foreground))" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "hsl(var(--muted-foreground))" },
    }));
    return { nodes, edges };
  }, [dag, statuses]);

  return (
    <div style={{ height }} className="surface overflow-hidden">
      <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false}>
        <Background color="hsl(var(--border))" gap={16} />
        <Controls className="!bg-card !border-border" />
      </ReactFlow>
    </div>
  );
}
