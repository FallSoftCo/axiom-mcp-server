# Axiom MCP Server

MCP server for accessing Axiom logs through Claude.

## Deployment to Fly.io

1. Install Fly CLI if not already installed
2. Authenticate with Fly: `fly auth login`
3. Set the Axiom API token as a secret:
   ```bash
   fly secrets set AXIOM_API_TOKEN=xaat-b7d32f2d-76e5-4c44-be33-c702fa2a74a6
   ```
4. Deploy:
   ```bash
   fly deploy
   ```

## Configuration in Claude

Once deployed, update your MCP configuration to use the remote server:

```json
{
  "mcpServers": {
    "delicious-sienna-fluke": {
      "transport": "sse",
      "url": "https://axiom-mcp-server.fly.dev/sse"
    }
  }
}
```