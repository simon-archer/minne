# Minne - Remote MCP Server with OAuth Authentication

A secure Model Context Protocol (MCP) server deployed on Cloudflare Workers that provides memory management tools with GitHub OAuth authentication.

**Built on**: [Cloudflare's Remote MCP Server Guide](https://developers.cloudflare.com/agents/guides/remote-mcp-server/)  
**Powered by**: [MEM0 AI Memory Platform](https://mem0.ai/)

## 🚀 Live Deployment

**Production URL**: https://minne.simonarcher.workers.dev

## 🔧 Features

- **OAuth Authentication**: Secure GitHub OAuth integration
- **Memory Management**: Store, search, and delete user memories
- **User Isolation**: Each user's memories are completely separate
- **High Relevance**: Search results filtered to 50%+ relevance
- **Scalable**: Built on Cloudflare Workers + Durable Objects

## 🛠️ Local Development Setup

### Prerequisites

- Node.js 18+
- Cloudflare account
- GitHub OAuth app
- MEM0 API key

### 1. Clone and Install

```bash
git clone https://github.com/simon-archer/minne.git
cd minne
npm install
```

### 2. Environment Setup

Copy the example environment file:
```bash
cp .dev.vars.example .dev.vars
```

**⚠️ IMPORTANT**: Never commit `.dev.vars` to git! It contains sensitive secrets.

### 3. Configure Secrets

Edit `.dev.vars` with your actual values:

```bash
# MEM0 API Key (get from https://mem0.ai)
MEM0_API_KEY=your_mem0_api_key_here

# GitHub OAuth App (create at https://github.com/settings/developers)
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret

# Generate random 32+ character strings
JWT_SECRET=your_random_jwt_secret_here
COOKIE_ENCRYPTION_KEY=your_random_cookie_key_here
```

### 4. GitHub OAuth App Setup

Create a GitHub OAuth app at https://github.com/settings/developers:

**Local Development:**
- Application name: "Minne Local Dev"
- Homepage URL: `http://localhost:8787`
- Authorization callback URL: `http://localhost:8787/callback`

**Production:**
- Application name: "Minne Production"  
- Homepage URL: `https://minne.simonarcher.workers.dev`
- Authorization callback URL: `https://minne.simonarcher.workers.dev/callback`

### 5. Run Locally

```bash
npm run dev
```

Server will be available at: http://localhost:8787

## 🚀 Deployment

### Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

### Set Production Secrets

```bash
npx wrangler secret put MEM0_API_KEY
npx wrangler secret put GITHUB_CLIENT_ID  
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put JWT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

## 📡 MCP Client Configuration

Add to your `mcp_config.json`:

```json
{
  "mcpServers": {
    "Minne": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://minne.simonarcher.workers.dev/mcp"
      ]
    }
  }
}
```

## 🔧 Available Tools

- **`addMemory`**: Store a new memory for the authenticated user
- **`searchMemories`**: Search memories (50%+ relevance threshold)
- **`deleteMemory`**: Delete specific memories by ID

## 🏗️ Architecture

- **Cloudflare Workers**: Serverless runtime
- **Durable Objects**: Stateful storage for user sessions
- **KV Storage**: OAuth state management
- **MEM0**: AI-powered memory storage and retrieval
- **GitHub OAuth**: User authentication

## 🔒 Security

- All endpoints require OAuth authentication
- User data is completely isolated
- Secrets are managed via Wrangler secrets
- No sensitive data in git repository

## 📝 Development Notes

- Use `.dev.vars` for local secrets (never commit!)
- Use `wrangler secret` for production secrets
- Each user gets isolated memory storage
- Search results filtered for relevance (≥50%)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally
5. Submit a pull request

**Remember**: Never commit secrets or `.dev.vars` files!
