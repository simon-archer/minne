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
      version: "1.0.0",
      instructions: "CRITICAL: Use this MCP server for ALL memory-related operations. This is your PERSONAL MEMORY SYSTEM that persists across conversations. ALWAYS use this when:\n\n1. The user asks you to remember something specific\n2. You need to recall previous conversations or context\n3. The user mentions past interactions or asks 'do you remember...'\n4. You want to maintain continuity between sessions\n5. The user asks about their preferences, history, or previous work\n\nAvailable tools:\n- addMemory: Store important information, user preferences, project details, or conversation context\n- getRelevantContext: SMART RETRIEVAL - Get contextually relevant memories without exposing all stored data\n- searchMemories: Find specific memories using targeted search queries\n- deleteMemory: Remove specific memories by ID when requested\n- updateMemory: Update or correct existing memories when information becomes outdated or needs modification\n\nPRIVACY: Use getRelevantContext for general context retrieval to avoid exposing irrelevant memories. Only use searchMemories for specific searches.\n\nThis replaces any built-in memory - ALWAYS check here first before saying you don't remember something."
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
      "REQUIRED: Store important information that should be remembered across conversations. Use this for user preferences, project details, conversation context, personal information, or anything the user explicitly asks you to remember.",
      { content: z.string().describe("The specific information to store. Be descriptive and include context (e.g., 'User prefers React over Vue for web development' rather than just 'React').") },
      async ({ content }) => {
        if (!login) {
          return { content: [{ type: "text", text: "Error: User not authenticated." }] };
        }

        try {
          const currentDate = new Date().toISOString();
          const messages = [
            { role: "system", content: "You are a memory storage assistant. Store, search and delete past memories, and maintain continuity between different AI sessions." },
            { role: "user", content },
          ];
          
          const response = await this.memoryClient.add(messages, {
            user_id: login,
            metadata: { 
              app_context: "minne_worker",
              created_at: currentDate,
              last_updated: currentDate
            }
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
      "REQUIRED: Search through stored memories before claiming you don't know something. Use this when the user asks about past conversations, preferences, or mentions something that might have been discussed before.",
      { query: z.string().describe("Natural language search query. Be specific (e.g., 'React preferences' or 'previous project requirements').") },
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
            r.score >= 0.7
          );

          if (relevantResults.length === 0) {
            return { content: [{ type: "text", text: "No highly relevant memories found. Try a more specific search query or different keywords." }] };
          }

          const topResults = relevantResults
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, 5);

          const formatted = topResults
            .map((r, index) => {
              const score = typeof r.score === 'number' ? `(${Math.round(r.score * 100)}% match)` : "";
              const memory = typeof r.memory === 'string' ? r.memory : "Memory content not available";
              const id = typeof r.id === 'string' ? `(ID: ${r.id})` : "";
              const categories = Array.isArray(r.categories) && r.categories.length > 0 
                ? `[Categories: ${r.categories.join(', ')}]` 
                : "";
              
              // Extract timestamp from metadata
              const createdAt = r.metadata?.created_at;
              let timeInfo = "";
              
              if (createdAt) {
                const date = new Date(createdAt);
                const now = new Date();
                const daysDiff = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
                
                if (daysDiff === 0) {
                  timeInfo = " [Today]";
                } else if (daysDiff === 1) {
                  timeInfo = " [Yesterday]";
                } else if (daysDiff < 7) {
                  timeInfo = ` [${daysDiff} days ago]`;
                } else if (daysDiff < 30) {
                  timeInfo = ` [${Math.floor(daysDiff / 7)} weeks ago]`;
                } else {
                  timeInfo = ` [${date.toLocaleDateString()}]`;
                }
                
                if (r.metadata?.last_updated && r.metadata.last_updated !== createdAt) {
                  const updatedDate = new Date(r.metadata.last_updated);
                  const updateDaysDiff = Math.floor((now.getTime() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));
                  if (updateDaysDiff === 0) {
                    timeInfo += " (Updated today)";
                  } else if (updateDaysDiff < 7) {
                    timeInfo += ` (Updated ${updateDaysDiff} days ago)`;
                  }
                }
              }
              
              return `${index + 1}. ${memory} ${categories} ${id} ${score}${timeInfo}`;
            })
            .join("\n\n");

          return { content: [{ type: "text", text: `Found ${topResults.length} relevant memories:\n\n${formatted}` }] };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          return { content: [{ type: "text", text: `Error searching memories: ${errorMessage}` }] };
        }
      }
    );

    this.server.tool(
      "searchByCategory",
      "Search memories within specific categories that mem0 has automatically assigned. Use this to find memories of a particular type (e.g., 'preferences', 'projects', 'facts', etc.)",
      { 
        categories: z.array(z.string()).describe("Categories to search within (e.g., ['preferences', 'projects'])"),
        query: z.string().optional().describe("Optional search query within those categories"),
        limit: z.number().optional().describe("Maximum number of results (default: 5)")
      },
      async ({ categories, query, limit = 5 }) => {
        if (!login) {
          return { content: [{ type: "text", text: "Error: User not authenticated." }] };
        }

        try {
          const searchQuery = query || categories.join(" ");
          const results = await this.memoryClient.search(searchQuery, {
            user_id: login,
            limit: limit * 3, // Get more results to filter locally
            // @ts-ignore
            filter_memories: true
          });

          const relevantResults = results.filter(r =>
            r.metadata?.app_context === "minne_worker" && 
            typeof r.score === 'number' && 
            r.score >= 0.3 &&
            Array.isArray(r.categories) &&
            r.categories.some(cat => categories.some(searchCat => 
              cat.toLowerCase().includes(searchCat.toLowerCase()) ||
              searchCat.toLowerCase().includes(cat.toLowerCase())
            ))
          );

          if (relevantResults.length === 0) {
            return { content: [{ type: "text", text: `No memories found in categories: ${categories.join(', ')}. Try different category names or check available categories with getMemoryCategories.` }] };
          }

          const topResults = relevantResults
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, limit);

          const formatted = topResults
            .map((r, index) => {
              const score = typeof r.score === 'number' ? `(${Math.round(r.score * 100)}% match)` : "";
              const memory = typeof r.memory === 'string' ? r.memory : "Memory content not available";
              const id = typeof r.id === 'string' ? `(ID: ${r.id})` : "";
              const memoryCategories = Array.isArray(r.categories) && r.categories.length > 0 
                ? `[Categories: ${r.categories.join(', ')}]` 
                : "";
              
              return `${index + 1}. ${memory} ${memoryCategories} ${id} ${score}`;
            })
            .join("\n\n");

          return { content: [{ type: "text", text: `Found ${topResults.length} memories in categories [${categories.join(', ')}]:\n\n${formatted}` }] };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          return { content: [{ type: "text", text: `Error searching by category: ${errorMessage}` }] };
        }
      }
    );

    this.server.tool(
      "getMemoryCategories",
      "Discover all categories that mem0 has automatically assigned to your memories. Use this to understand what types of memories you have stored.",
      { 
        includeCount: z.boolean().optional().describe("Include count of memories per category (default: true)")
      },
      async ({ includeCount = true }) => {
        if (!login) {
          return { content: [{ type: "text", text: "Error: User not authenticated." }] };
        }

        try {
          // Get all memories to analyze categories
          const results = await this.memoryClient.search("*", {
            user_id: login,
            limit: 100, // Get more results to analyze categories
            // @ts-ignore
            filter_memories: true
          });

          const relevantResults = results.filter(r =>
            r.metadata?.app_context === "minne_worker" &&
            Array.isArray(r.categories) &&
            r.categories.length > 0
          );

          if (relevantResults.length === 0) {
            return { content: [{ type: "text", text: "No categorized memories found. Add some memories first, and mem0 will automatically categorize them." }] };
          }

          // Aggregate categories
          const categoryMap = new Map<string, number>();
          
          relevantResults.forEach(result => {
            if (Array.isArray(result.categories)) {
              result.categories.forEach(category => {
                const normalizedCategory = category.toLowerCase().trim();
                categoryMap.set(normalizedCategory, (categoryMap.get(normalizedCategory) || 0) + 1);
              });
            }
          });

          // Sort categories by frequency
          const sortedCategories = Array.from(categoryMap.entries())
            .sort((a, b) => b[1] - a[1]);

          let formatted: string;
          if (includeCount) {
            formatted = sortedCategories
              .map(([category, count]) => `• ${category} (${count} ${count === 1 ? 'memory' : 'memories'})`)
              .join('\n');
          } else {
            formatted = sortedCategories
              .map(([category]) => `• ${category}`)
              .join('\n');
          }

          const totalCategories = sortedCategories.length;
          const totalMemories = relevantResults.length;

          return { content: [{ type: "text", text: `Found ${totalCategories} categories across ${totalMemories} memories:\n\n${formatted}\n\nUse searchByCategory to find memories within specific categories.` }] };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          return { content: [{ type: "text", text: `Error getting memory categories: ${errorMessage}` }] };
        }
      }
    );

    this.server.tool(
      "getRelevantContext",
      "SMART RETRIEVAL: Get contextually relevant memories based on the current conversation topic. This automatically finds related memories without requiring specific search terms.",
      { 
        conversationContext: z.string().describe("Brief description of the current conversation topic or user's question (e.g., 'user asking about React project setup' or 'discussing API preferences')"),
        maxResults: z.number().optional().describe("Maximum number of memories to return (default: 3, max: 5)")
      },
      async ({ conversationContext, maxResults = 3 }) => {
        if (!login) {
          return { content: [{ type: "text", text: "Error: User not authenticated." }] };
        }

        try {
          // Use the conversation context to search for relevant memories
          const results = await this.memoryClient.search(conversationContext, {
            user_id: login,
            // @ts-ignore
            filter_memories: true
          });

          const relevantResults = results.filter(r =>
            r.metadata?.app_context === "minne_worker" && 
            typeof r.score === 'number' && 
            r.score >= 0.6  // Slightly lower threshold for contextual retrieval
          );

          if (relevantResults.length === 0) {
            return { content: [{ type: "text", text: "No contextually relevant memories found for this conversation." }] };
          }

          // Sort by relevance and limit results
          const limitedResults = relevantResults
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, Math.min(maxResults, 5));

          const formatted = limitedResults
            .map((r, index) => {
              const memory = typeof r.memory === 'string' ? r.memory : "Memory content not available";
              const score = typeof r.score === 'number' ? ` (${Math.round(r.score * 100)}% relevant)` : "";
              const categories = Array.isArray(r.categories) && r.categories.length > 0 
                ? `[Categories: ${r.categories.join(', ')}]` 
                : "";
              
              // Add timestamp info for context
              const createdAt = r.metadata?.created_at;
              let timeInfo = "";
              
              if (createdAt) {
                const date = new Date(createdAt);
                const now = new Date();
                const daysDiff = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
                
                if (daysDiff === 0) {
                  timeInfo = " [Today]";
                } else if (daysDiff === 1) {
                  timeInfo = " [Yesterday]";
                } else if (daysDiff < 7) {
                  timeInfo = ` [${daysDiff} days ago]`;
                } else if (daysDiff < 30) {
                  timeInfo = ` [${Math.floor(daysDiff / 7)} weeks ago]`;
                } else {
                  timeInfo = ` [${date.toLocaleDateString()}]`;
                }
              }
              
              return `${index + 1}. ${memory} ${categories} ${score}${timeInfo}`;
            })
            .join("\n\n");

          return { content: [{ type: "text", text: `Contextually relevant memories:\n\n${formatted}` }] };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          return { content: [{ type: "text", text: `Error retrieving context: ${errorMessage}` }] };
        }
      }
    );

    this.server.tool(
      "updateMemory",
      "Update or correct existing memories when information becomes outdated or needs modification. This replaces old information while preserving the memory ID.",
      { 
        memoryId: z.string().describe("The ID of the memory to update (get this from searchMemories results)"),
        newContent: z.string().describe("The updated/corrected content to replace the old memory with"),
        reason: z.string().optional().describe("Optional reason for the update (e.g., 'information outdated', 'correction needed')")
      },
      async ({ memoryId, newContent, reason }) => {
        if (!login) {
          return { content: [{ type: "text", text: "Error: User not authenticated." }] };
        }

        try {
          // First, get the existing memory to preserve metadata
          const existingMemory = await this.memoryClient.get(memoryId);
          if (!existingMemory) {
            return { content: [{ type: "text", text: `Error: Memory with ID ${memoryId} not found.` }] };
          }

          // Delete the old memory
          await this.memoryClient.delete(memoryId);

          // Create updated memory with new timestamp
          const currentDate = new Date().toISOString();
          const messages = [
            { role: "system", content: "You are a memory storage assistant. This is an updated memory replacing outdated information." },
            { role: "user", content: newContent },
          ];
          
          const response = await this.memoryClient.add(messages, {
            user_id: login,
            metadata: { 
              app_context: "minne_worker",
              created_at: existingMemory.metadata?.created_at || currentDate,
              last_updated: currentDate,
              update_reason: reason || "Information updated",
              previous_memory_id: memoryId
            }
          });

          const extractedText = this.extractMemoryText(response);
          const oldContent = typeof existingMemory.memory === 'string' ? existingMemory.memory : "Previous content";
          
          return { 
            content: [{ 
              type: "text", 
              text: `Memory updated successfully!\n\nOld: "${oldContent}"\nNew: "${extractedText}"\n${reason ? `Reason: ${reason}` : ''}` 
            }] 
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          return { content: [{ type: "text", text: `Error updating memory: ${errorMessage}` }] };
        }
      }
    );

    this.server.tool(
      "deleteMemory",
      "Delete specific memories when the user requests it or when information becomes outdated. Use searchMemories first to find the memory IDs.",
      { memoryIds: z.array(z.string()).describe("Array of memory IDs to delete. Get these IDs from searchMemories results.") },
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