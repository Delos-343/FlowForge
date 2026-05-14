/**
 * FlowForge — AI Workflow Builder
 * POST /ai-build-workflow { prompt: string }
 * Returns: { dag: { nodes, edges, timeout_ms }, name, description }
 *
 * Uses Lovable AI tool calling for guaranteed structured output.
 * Token guard: prompt is hard-truncated. Output is validated before return.
 */
// @ts-nocheck
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You design FlowForge workflow DAGs. A workflow is a directed acyclic graph of steps.

Step types you can use:
- "http": call an external HTTP endpoint. fields: url (required), method (GET/POST/PUT/DELETE/PATCH), headers, body, expect_status
- "delay": sleep. fields: ms (1..60000)
- "script": template-render an expression. fields: expression (string)
- "condition": branch on a comparison. fields: expression (e.g. "{{ steps.fetch.status }} == 200"), on_true (node id), on_false (node id, optional)

Templating (available in url, body strings, expression):
- {{ steps.<node_id>.<path> }}  — output of a previous step (e.g. {{ steps.fetch.body.id }})
- {{ input.<path> }}            — workflow trigger input (may be empty for manual runs)

Rules:
- Output a valid DAG (no cycles).
- Node ids: lowercase, snake_case, unique, [a-z0-9_-], <= 32 chars.
- Use 1..15 nodes. Prefer parallel edges when steps are independent.
- Include retry policy on http steps: { max_attempts: 3, backoff_ms: 1000, multiplier: 2 }.
- timeout_ms: realistic global timeout (default 60000).

CRITICAL — workflows MUST be runnable out of the box with no configuration:
- NEVER use fictional hostnames like example.com, api.example.com, crm.example.com, your-domain.com, etc. Those fail DNS.
- Use ONLY these real, free, no-auth public APIs that always resolve:
    * https://jsonplaceholder.typicode.com  (fake REST: /users, /users/1, /posts, /todos, /comments — supports GET/POST/PUT/DELETE)
    * https://httpbin.org                    (echo/test: /get, /post, /status/200, /delay/1, /uuid, /json, /anything)
    * https://api.github.com                 (public read endpoints like /users/octocat, /repos/torvalds/linux)
    * https://dummyjson.com                  (/products, /users, /carts, /auth/login)
    * https://catfact.ninja/fact, https://api.agify.io?name=foo, https://api.publicapis.org/entries
- Pick endpoints that match the user's intent semantically (e.g. "fetch CRM user" -> https://jsonplaceholder.typicode.com/users/1; "POST to billing" -> https://httpbin.org/post).
- Do NOT depend on {{ input.* }} unless you also default it. Manual runs send no input. Prefer hardcoded sample IDs in the URL (e.g. /users/1) over {{ input.user_id }}. If you must reference input, also work when it is empty.
- Never invent secrets, API keys, or auth headers.

Return via the create_workflow tool only.`;

const TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "create_workflow",
    description: "Emit a validated FlowForge workflow definition.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 80 },
        description: { type: "string", maxLength: 240 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
        nodes: {
          type: "array",
          minItems: 1,
          maxItems: 15,
          items: {
            type: "object",
            required: ["id", "name", "step"],
            properties: {
              id: { type: "string", pattern: "^[a-z0-9_-]+$" },
              name: { type: "string" },
              step: {
                type: "object",
                required: ["type"],
                properties: {
                  type: { type: "string", enum: ["http", "delay", "script", "condition"] },
                  url: { type: "string" },
                  method: { type: "string", enum: ["GET","POST","PUT","DELETE","PATCH"] },
                  headers: { type: "object" },
                  body: {},
                  expect_status: { type: "integer" },
                  ms: { type: "integer" },
                  expression: { type: "string" },
                  on_true: { type: "string" },
                  on_false: { type: "string" },
                },
              },
              retry: {
                type: "object",
                properties: {
                  max_attempts: { type: "integer", minimum: 1, maximum: 10 },
                  backoff_ms: { type: "integer", minimum: 0 },
                  multiplier: { type: "number", minimum: 1 },
                },
              },
            },
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            required: ["from", "to"],
            properties: { from: { type: "string" }, to: { type: "string" } },
          },
        },
      },
      required: ["name", "nodes", "edges"],
      additionalProperties: false,
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { prompt } = await req.json();
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return json({ error: "prompt required" }, 400);
    }
    // Token guard
    const safePrompt = prompt.trim().slice(0, 1500);

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) return json({ error: "AI not configured" }, 500);

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: safePrompt },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: { type: "function", function: { name: "create_workflow" } },
      }),
    });

    if (aiRes.status === 429) return json({ error: "Rate limited. Please retry shortly." }, 429);
    if (aiRes.status === 402) return json({ error: "AI credits exhausted." }, 402);
    if (!aiRes.ok) {
      const txt = await aiRes.text();
      console.error("AI gateway error:", aiRes.status, txt);
      return json({ error: "AI gateway error" }, 502);
    }

    const data = await aiRes.json();
    const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) return json({ error: "AI returned no tool call" }, 500);

    let parsed: any;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch {
      return json({ error: "AI returned malformed JSON" }, 500);
    }

    // Light server-side validation
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
      return json({ error: "AI returned no nodes" }, 500);
    }

    return json({
      name: String(parsed.name ?? "Untitled"),
      description: String(parsed.description ?? ""),
      dag: {
        nodes: parsed.nodes,
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        timeout_ms: parsed.timeout_ms ?? 60000,
      },
    });
  } catch (e) {
    console.error("ai-build-workflow:", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
