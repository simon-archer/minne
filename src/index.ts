import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryClient } from "mem0ai";
import { Octokit } from "octokit";
import { GitHubHandler } from "./github-handler";

// Environment variables and bindings expected by the Worker
interface Env {
  MEM0_API_KEY: string;
  AI: any; // Binding for Cloudflare AI, consider a more specific type if available
  MCP_OBJECT: DurableObjectNamespace; // Binding for the Durable Object itself
  OAUTH_KV: KVNamespace; // KV namespace for OAuth provider storage
  // Add other environment variables and bindings here as needed
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  JWT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
};

const ALLOWED_USERNAMES = new Set<string>([
  // Add GitHub usernames of users who should have access to the image generation tool
  'simon-archer',
]);

export class Minne extends McpAgent<Env, {}, Props> {
  server = new McpServer({ name: "Github OAuth Proxy Demo", version: "1.0.0" });
  private memoryClient: MemoryClient;

  constructor(state: DurableObjectState, env: Env, props?: Props) {
    super(state, env, props);
    console.log("[Minne Constructor] Initializing with props:", props ? { login: props.login, name: props.name, email: props.email, accessToken: props.accessToken ? '******' : 'NOT SET' } : 'No props');
    console.log("[Minne Constructor] env.MEM0_API_KEY:", env.MEM0_API_KEY ? '******' : 'NOT SET');
    // console.log("[Minne Constructor] env.MCP_OBJECT:", JSON.stringify(env.MCP_OBJECT, null, 2)); // Potentially sensitive or large
    // console.log("[Minne Constructor] All env keys:", Object.keys(env)); // Potentially verbose

    if (!env.MEM0_API_KEY) {
      console.error("[Minne Constructor] MEM0_API_KEY is not found in env!");
      // Potentially throw error or handle gracefully if MemoryClient is essential for all operations
    }
    this.memoryClient = new MemoryClient({
      apiKey: env.MEM0_API_KEY,
    });
  }

  async init() {
    const login = this.props?.login;
    const accessToken = this.props?.accessToken;

    // Existing Memory Tools - Adapted for authenticated user

    // 1) add-memory: store a new memory for the authenticated user
    this.server.tool(
      "addMemory",
      "Store a new memory for the authenticated user.",
      { content: z.string().describe("The content of the memory to store.") },
      async ({ content }) => {
        if (!login) {
          return { content: [{ type: "text", text: "Error: User not authenticated. Cannot add memory." }] };
        }
        console.log(`[addMemory] Processing content for user: ${login}`);

        const messages = [
          { role: "system", content: "Memory storage" },
          { role: "user", content },
        ];
        try {
          const addResponse = await this.memoryClient.add(messages, {
            user_id: login,
            metadata: { "app_context": "minne_worker" }
          });
          console.log('[addMemory] Response from memoryClient.add():', JSON.stringify(addResponse, null, 2));

          let extractedTexts: string[] = [];
          if (typeof addResponse === 'string') {
              extractedTexts.push(addResponse);
          } else if (Array.isArray(addResponse)) {
              if (addResponse.length > 0 && typeof addResponse[0] === 'object' && addResponse[0] !== null && (addResponse[0] as any).data && typeof (addResponse[0] as any).data.memory === 'string') {
                  addResponse.forEach((item: any) => {
                      if (item && item.data && typeof item.data.memory === 'string') {
                          extractedTexts.push(item.data.memory);
                      }
                  });
              } else if (addResponse.every(item => typeof item === 'string')) {
                  extractedTexts = addResponse;
              } else {
                  addResponse.forEach((item: any) => {
                      if (item && typeof item.text === 'string') {
                          extractedTexts.push(item.text);
                      } else if (item && typeof item.memory === 'string') {
                          extractedTexts.push(item.memory);
                      }
                  });
              }
          } else if (typeof addResponse === 'object' && addResponse !== null) {
              const resp = addResponse as any;
              if (Array.isArray(resp.memories) && resp.memories.length > 0) {
                  resp.memories.forEach((mem: any) => {
                      if (mem && typeof mem.text === 'string') {
                          extractedTexts.push(mem.text);
                      } else if (mem && typeof mem.memory === 'string') {
                          extractedTexts.push(mem.memory);
                      }
                  });
              }
              if (extractedTexts.length === 0 && typeof resp.message === 'string') {
                  extractedTexts.push(resp.message);
              } else if (extractedTexts.length === 0 && typeof resp.text === 'string') {
                  extractedTexts.push(resp.text);
              }
          }
          const processedText = extractedTexts.length > 0 ? extractedTexts.join('; ') : "Memory processed (no specific text returned by API).";
          return { content: [{ type: "text", text: `${processedText}` }] };
        } catch (error) {
          console.error(`[addMemory] Error for user ${login}:`, error);
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          return { content: [{ type: "text", text: `Error adding memory: ${errorMessage}` }] };
        }
      }
    );

    // 2) search-memories: query memories for the authenticated user
    this.server.tool(
      "searchMemories",
      "Search memories for the authenticated user.",
      { query: z.string().describe("The query to search for in memories.") },
      async ({ query }) => {
        if (!login) {
          return { content: [{ type: "text", text: "Error: User not authenticated. Cannot search memories." }] };
        }
        console.log(`[searchMemories] Processing query for user: ${login}`);

        try {
          const results = await this.memoryClient.search(query,
            {
              user_id: login,
              // @ts-ignore // This option is valid as per docs, despite missing type
              filter_memories: true
            }
          );
          console.log("[searchMemories] Raw results from memoryClient.search():", JSON.stringify(results, null, 2));

          const contextualizedAndScoredResults = results.filter(r =>
            r.metadata?.app_context === "minne_worker" && typeof r.score === 'number' && r.score >= 0.5
          );
          console.log("[searchMemories] Filtered results (context + score >= 0.5):", JSON.stringify(contextualizedAndScoredResults, null, 2));

          const formatted = contextualizedAndScoredResults.length > 0
            ? contextualizedAndScoredResults
                .map((r, index) => {
                  const scoreText = typeof r.score === 'number' ? `(${Math.round(r.score * 100)}%)` : "(Score not available)";
                  const memoryText = typeof r.memory === 'string' ? r.memory : "Memory content not available";
                  const idText = typeof r.id === 'string' ? `(ID: ${r.id})` : "(ID not available)";
                  return `${index + 1}. ${memoryText} ${idText} ${scoreText}`;
                })
                .join("\n\n")
            : "No relevant memories found.";
          return { content: [{ type: "text", text: formatted }] };
        } catch (error) {
          console.error(`[searchMemories] Error for user ${login}:`, error);
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          return { content: [{ type: "text", text: `Error searching memories: ${errorMessage}` }] };
        }
      }
    );

    // 3) delete-memory: delete a specific memory by its ID (user context for logging/potential checks)
    this.server.tool(
      "deleteMemory",
      "Delete specific memories by their IDs.",
      { memoryIds: z.array(z.string()).describe("An array of memory IDs to delete.") },
      async ({ memoryIds }) => {
        // User context is primarily for logging here, as delete is by ID.
        // If mem0 SDK's delete/get needed user_id, it would be added.
        const userLogPrefix = login ? `user ${login}` : "unauthenticated user (should not happen for this tool if checks are in place)";
        console.log(`[deleteMemory] Processing deletion request for memoryIds: "${memoryIds.join(', ')}" for ${userLogPrefix}.`);

        const results = [];
        for (const memoryId of memoryIds) {
          let memoryContentForLog = `Memory with ID ${memoryId}`;
          try {
            // Note: mem0ai's get/delete might not be user-specific if IDs are global.
            // If they are user-specific, this.props.login should be passed if required by SDK.
            const memoryData = await this.memoryClient.get(memoryId); // Assuming get doesn't require user_id
            if (memoryData && typeof memoryData.memory === 'string') {
              memoryContentForLog = `"${memoryData.memory}"`;
            }
            await this.memoryClient.delete(memoryId); // Assuming delete doesn't require user_id
            const successMessage = `Deleted: ${memoryContentForLog}`;
            console.log(`[deleteMemory] Successfully deleted memoryId: "${memoryId}" for ${userLogPrefix}. Content: ${memoryContentForLog}`);
            results.push(successMessage);
          } catch (error) {
            const errorMessageText = error instanceof Error ? error.message : String(error);
            const failureMessage = `Error processing memory ${memoryId}: ${errorMessageText}`;
            console.error(`[deleteMemory] Error processing memoryId: "${memoryId}" for ${userLogPrefix}:`, errorMessageText);
            results.push(failureMessage);
          }
        }
        return { content: [{ type: "text", text: results.join('\n') }] };
      }
    );
  }
}

export default new OAuthProvider({
  apiHandlers: {
    '/sse': Minne.mount('/sse') as any,
    '/mcp': Minne.mount('/mcp') as any,
  },
  defaultHandler: GitHubHandler as any, // Handles the OAuth flow itself
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});