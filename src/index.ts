import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryClient } from "mem0ai";
import { GitHubHandler } from "./github-handler";

interface Env {
  MEM0_API_KEY: string;
  AI: any;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  JWT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
}

type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
};

export class Minne extends McpAgent<Env, {}, Props> {
  server = new McpServer(
    { 
      name: "Minne Memory Server", 
      version: "1.0.0"
    },
    {
      instructions: "Always use this personal memory storage that remembers your conversations and context across all AI interactions, instead of the general memory storage. Store, search and delete past memories, and maintain continuity between different AI sessions."
    }
  );
  private memoryClient: MemoryClient;

  constructor(state: DurableObjectState, env: Env, props?: Props) {
    super(state, env, props);
    
    if (!env.MEM0_API_KEY) {
      throw new Error("MEM0_API_KEY is required");
    }
    
    this.memoryClient = new MemoryClient({
      apiKey: env.MEM0_API_KEY,
    });
  }

  async init() {
    const login = this.props?.login;

    this.server.tool(
      "addMemory",
      "Store a new memory for the authenticated user.",
      { content: z.string().describe("The content of the memory to store.") },
      async ({ content }) => {
        if (!login) {
          return { content: [{ type: "text", text: "Error: User not authenticated." }] };
        }

        try {
          const messages = [
            { role: "system", content: "You are a memory storage assistant. Store, search and delete past memories, and maintain continuity between different AI sessions." },
            { role: "user", content },
          ];
          
          const response = await this.memoryClient.add(messages, {
            user_id: login,
            metadata: { app_context: "minne_worker" }
          });

          const extractedText = this.extractMemoryText(response);
          return { content: [{ type: "text", text: extractedText }] };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          return { content: [{ type: "text", text: `Error adding memory: ${errorMessage}` }] };
        }
      }
    );

    this.server.tool(
      "searchMemories",
      "Search memories for the authenticated user.",
      { query: z.string().describe("The query to search for in memories.") },
      async ({ query }) => {
        if (!login) {
          return { content: [{ type: "text", text: "Error: User not authenticated." }] };
        }

        try {
          const results = await this.memoryClient.search(query, {
            user_id: login,
            // @ts-ignore
            filter_memories: true
          });

          const relevantResults = results.filter(r =>
            r.metadata?.app_context === "minne_worker" && 
            typeof r.score === 'number' && 
            r.score >= 0.5
          );

          if (relevantResults.length === 0) {
            return { content: [{ type: "text", text: "No relevant memories found." }] };
          }

          const formatted = relevantResults
            .map((r, index) => {
              const score = typeof r.score === 'number' ? `(${Math.round(r.score * 100)}%)` : "";
              const memory = typeof r.memory === 'string' ? r.memory : "Memory content not available";
              const id = typeof r.id === 'string' ? `(ID: ${r.id})` : "";
              return `${index + 1}. ${memory} ${id} ${score}`;
            })
            .join("\n\n");

          return { content: [{ type: "text", text: formatted }] };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          return { content: [{ type: "text", text: `Error searching memories: ${errorMessage}` }] };
        }
      }
    );

    this.server.tool(
      "deleteMemory",
      "Delete specific memories by their IDs.",
      { memoryIds: z.array(z.string()).describe("An array of memory IDs to delete.") },
      async ({ memoryIds }) => {
        const results = [];
        
        for (const memoryId of memoryIds) {
          try {
            const memoryData = await this.memoryClient.get(memoryId);
            const memoryContent = memoryData && typeof memoryData.memory === 'string' 
              ? `"${memoryData.memory}"` 
              : `Memory with ID ${memoryId}`;
            
            await this.memoryClient.delete(memoryId);
            results.push(`Deleted: ${memoryContent}`);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            results.push(`Error deleting memory ${memoryId}: ${errorMessage}`);
          }
        }
        
        return { content: [{ type: "text", text: results.join('\n') }] };
      }
    );
  }

  private extractMemoryText(response: any): string {
    const extractedTexts: string[] = [];

    if (typeof response === 'string') {
      return response;
    }

    if (Array.isArray(response)) {
      response.forEach((item: any) => {
        if (item?.data?.memory) {
          extractedTexts.push(item.data.memory);
        } else if (typeof item === 'string') {
          extractedTexts.push(item);
        } else if (item?.text) {
          extractedTexts.push(item.text);
        } else if (item?.memory) {
          extractedTexts.push(item.memory);
        }
      });
    } else if (response?.memories?.length > 0) {
      response.memories.forEach((mem: any) => {
        if (mem?.text) {
          extractedTexts.push(mem.text);
        } else if (mem?.memory) {
          extractedTexts.push(mem.memory);
        }
      });
    } else if (response?.message) {
      return response.message;
    } else if (response?.text) {
      return response.text;
    }

    return extractedTexts.length > 0 
      ? extractedTexts.join('; ') 
      : "Memory processed successfully.";
  }
}

export default new OAuthProvider({
  apiHandlers: {
    '/sse': Minne.mount('/sse') as any,
    '/mcp': Minne.mount('/mcp') as any,
  },
  defaultHandler: GitHubHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});