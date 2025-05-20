import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryClient } from "mem0ai";

export class Minne extends McpAgent {
  server = new McpServer({ name: "Authless Memory", version: "1.0.0" });
  private memoryClient: MemoryClient;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    console.log("[Minne Constructor] Initializing...");
    console.log("[Minne Constructor] env.MEM0_API_KEY:", env.MEM0_API_KEY);
    console.log("[Minne Constructor] All env keys:", Object.keys(env));

    if (!env.MEM0_API_KEY) {
      console.error("[Minne Constructor] MEM0_API_KEY is not found in env!");
    }
    this.memoryClient = new MemoryClient({
      apiKey: env.MEM0_API_KEY,
    });
  }

  async init() {
    // … your existing tools …

    // 1) add-memory: store a new memory
    this.server.tool(
      "addMemory",
      { content: z.string(), userId: z.string() },
      async ({ content, userId }) => {
        console.log(`[addMemory] Received content: "${content}", userId: "${userId}"`);
        // mem0 wants an array of messages; we prefix with a system role
        const messages = [
          { role: "system", content: "Memory storage" },
          { role: "user", content },
        ];
        await this.memoryClient.add(messages, {
          user_id: userId,
          metadata: { "app_context": "minne_worker" }
        });
        return { content: [{ type: "text", text: "Memory added." }] };
      }
    );

    // 2) search-memories: query your vector store
    this.server.tool(
      "searchMemories",
      { query: z.string(), userId: z.string() },
      async ({ query, userId }) => {
        console.log(`[searchMemories] Received query: "${query}", userId: "${userId}"`);
        const results = await this.memoryClient.search(query, 
          {
            user_id: userId,
            // @ts-ignore // This option is valid as per docs, despite missing type
            filter_memories: true 
          }
        );
        console.log("[searchMemories] Raw results from memoryClient.search():", JSON.stringify(results, null, 2));

        // Client-side filtering
        const contextualizedAndScoredResults = results.filter(r => 
          r.metadata?.app_context === "minne_worker" && typeof r.score === 'number' && r.score >= 0.7
        );

        console.log("[searchMemories] Filtered results (context + score >= 0.7):", JSON.stringify(contextualizedAndScoredResults, null, 2));

        const formatted = contextualizedAndScoredResults.length > 0 
          ? contextualizedAndScoredResults
              .map((r) => {
                const percentageScore = Math.round((r.score || 0) * 100); // Ensure score is a number, default to 0 if undefined
                return `${r.memory}. ${percentageScore}% Relevance`;
              })
              .join("\n\n")
          : "No relevant memories found (context + score >= 0.7).";

        return {
          content: [{ type: "text", text: formatted }],
        };
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // @ts-ignore
      return Minne.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      // @ts-ignore
      return Minne.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  }
};