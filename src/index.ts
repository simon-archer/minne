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
        const addResponse = await this.memoryClient.add(messages, {
          user_id: userId,
          metadata: { "app_context": "minne_worker" }
        });

        console.log('[addMemory] Response from memoryClient.add():', JSON.stringify(addResponse, null, 2));

        let extractedTexts: string[] = [];

        if (typeof addResponse === 'string') {
            extractedTexts.push(addResponse);
        } else if (Array.isArray(addResponse)) {
            // Check for the new structure: [{ data: { memory: "..." } }]
            if (addResponse.length > 0 && typeof addResponse[0] === 'object' && addResponse[0] !== null && (addResponse[0] as any).data && typeof (addResponse[0] as any).data.memory === 'string') {
                addResponse.forEach((item: any) => {
                    if (item && item.data && typeof item.data.memory === 'string') {
                        extractedTexts.push(item.data.memory);
                    }
                });
            } else if (addResponse.every(item => typeof item === 'string')) {
                extractedTexts = addResponse; // Array of strings directly
            } else {
                // Attempt to extract from array of objects, assuming 'text' or 'memory' property directly on item
                addResponse.forEach((item: any) => { 
                    if (item && typeof item.text === 'string') {
                        extractedTexts.push(item.text);
                    } else if (item && typeof item.memory === 'string') { 
                        extractedTexts.push(item.memory);
                    }
                });
            }
        } else if (typeof addResponse === 'object' && addResponse !== null) {
            const resp = addResponse as any; // Cast to any for easier property access
            if (Array.isArray(resp.memories) && resp.memories.length > 0) {
                resp.memories.forEach((mem: any) => { // mem is any
                    if (mem && typeof mem.text === 'string') {
                        extractedTexts.push(mem.text);
                    } else if (mem && typeof mem.memory === 'string') { // Fallback for mem.memory
                        extractedTexts.push(mem.memory);
                    }
                });
            }
            // If no texts extracted from .memories array, or .memories doesn't exist,
            // try a top-level .message or .text property as a fallback for the whole response
            if (extractedTexts.length === 0 && typeof resp.message === 'string') {
                extractedTexts.push(resp.message);
            } else if (extractedTexts.length === 0 && typeof resp.text === 'string') {
                extractedTexts.push(resp.text);
            }
        }

        const processedText = extractedTexts.length > 0 ? extractedTexts.join('; ') : "Memory processed (no specific text returned by API).";

        return { content: [{ type: "text", text: `${processedText}` }] };
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