#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

// Axiom API configuration
const AXIOM_API_TOKEN = process.env.AXIOM_API_TOKEN || 'xaat-b7d32f2d-76e5-4c44-be33-c702fa2a74a6';
const AXIOM_DATASET = process.env.AXIOM_DATASET || 'tlyt-logs';
const AXIOM_API_URL = 'https://api.axiom.co/v1';
const PORT = process.env.PORT || 3456;

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Create MCP server
const mcpServer = new Server(
  {
    name: 'tlyt-logs',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper function to query Axiom logs
async function queryAxiom(apl, startTime = null, endTime = null) {
  console.log('Executing APL query:', apl);
  const body = {
    apl: apl,
    startTime: startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    endTime: endTime || new Date().toISOString()
  };

  const response = await fetch(`${AXIOM_API_URL}/datasets/_apl?format=legacy`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AXIOM_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Axiom API error: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();
  const logs = data.matches || [];
  
  // Simplify logs to only essential fields
  return logs.map(log => ({
    time: log._time,
    message: log.data?.message || 'No message',
    level: log.data?.level || 'info',
    source: log.data?.source || 'unknown',
    requestId: log.data?.request_id
  }));
}

// Define available tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'logs_recent',
        description: 'Get recent logs',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Number of logs to return (max 5)',
              default: 5
            }
          }
        }
      },
      {
        name: 'logs_search',
        description: 'Search logs by text',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query',
              required: true
            },
            limit: {
              type: 'number',
              description: 'Number of logs to return (max 5)',
              default: 5
            }
          },
          required: ['query']
        }
      },
      {
        name: 'logs_errors',
        description: 'Get error logs only',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Number of logs to return (max 5)',
              default: 5
            }
          }
        }
      },
      {
        name: 'logs_timeRange',
        description: 'Get logs within time range',
        inputSchema: {
          type: 'object',
          properties: {
            from: {
              type: 'string',
              description: 'Start timestamp (ISO 8601)',
              required: true
            },
            to: {
              type: 'string',
              description: 'End timestamp (ISO 8601)',
              required: true
            }
          },
          required: ['from', 'to']
        }
      },
      {
        name: 'logs_byRequest',
        description: 'Get all logs for a request ID',
        inputSchema: {
          type: 'object',
          properties: {
            requestId: {
              type: 'string',
              description: 'Request ID to search for',
              required: true
            }
          },
          required: ['requestId']
        }
      },
      {
        name: 'logs_stats',
        description: 'Get log statistics',
        inputSchema: {
          type: 'object',
          properties: {
            hours: {
              type: 'number',
              description: 'Number of hours to analyze',
              default: 24
            }
          }
        }
      }
    ]
  };
});

// Handle tool calls
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const MAX_LOGS = 5; // Hard limit to prevent token overflow
    
    switch (request.params.name) {
      case 'logs_recent': {
        const { limit = 5 } = request.params.arguments || {};
        const safeLimit = Math.min(limit, MAX_LOGS);
        const apl = `['${AXIOM_DATASET}'] | sort by _time desc | limit ${safeLimit}`;
        const logs = await queryAxiom(apl);
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_search': {
        const { query, limit = 5 } = request.params.arguments;
        const safeLimit = Math.min(limit, MAX_LOGS);
        const apl = `['${AXIOM_DATASET}'] | where message contains "${query}" | sort by _time desc | limit ${safeLimit}`;
        const logs = await queryAxiom(apl);
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_errors': {
        const { limit = 5 } = request.params.arguments || {};
        const safeLimit = Math.min(limit, MAX_LOGS);
        const apl = `['${AXIOM_DATASET}'] | where level == "error" | sort by _time desc | limit ${safeLimit}`;
        const logs = await queryAxiom(apl);
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_timeRange': {
        const { from, to } = request.params.arguments;
        const apl = `['${AXIOM_DATASET}'] | sort by _time desc | limit ${MAX_LOGS}`;
        const logs = await queryAxiom(apl, from, to);
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_byRequest': {
        const { requestId } = request.params.arguments;
        const apl = `['${AXIOM_DATASET}'] | where request_id == "${requestId}" | sort by _time asc | limit ${MAX_LOGS}`;
        const logs = await queryAxiom(apl);
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_stats': {
        const { hours = 24 } = request.params.arguments || {};
        const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        const apl = `['${AXIOM_DATASET}'] | summarize count() by bin(_time, 1h), level | sort by _time desc`;
        const stats = await queryAxiom(apl, startTime);
        return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
      }
      
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    console.error('Error:', error);
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

// SSE endpoint for MCP
app.get('/sse', async (req, res) => {
  console.log('SSE connection established');
  const transport = new SSEServerTransport('/message', res);
  await mcpServer.connect(transport);
});

// Message endpoint for MCP
app.post('/message', async (req, res) => {
  console.log('Received message:', req.body);
  res.json({ message: 'ok' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', dataset: AXIOM_DATASET });
});

// Debug endpoint
app.get('/debug/test-query', async (req, res) => {
  try {
    const apl = `['${AXIOM_DATASET}'] | sort by _time desc | limit 1`;
    console.log('Debug APL:', apl);
    const logs = await queryAxiom(apl);
    res.json({
      apl,
      count: logs.length,
      firstLog: logs[0],
      totalSize: JSON.stringify(logs).length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoints for direct HTTP access
app.post('/api/mcp/:tool', async (req, res) => {
  try {
    const toolName = req.params.tool;
    const args = req.body;
    const MAX_LOGS = 5;
    
    console.log(`API call to tool: ${toolName}`, args);
    
    let result;
    switch (toolName) {
      case 'logs_recent': {
        const { limit = 5 } = args;
        const safeLimit = Math.min(limit, MAX_LOGS);
        const apl = `['${AXIOM_DATASET}'] | sort by _time desc | limit ${safeLimit}`;
        result = await queryAxiom(apl);
        break;
      }
      
      case 'logs_search': {
        const { query, limit = 5 } = args;
        const safeLimit = Math.min(limit, MAX_LOGS);
        const apl = `['${AXIOM_DATASET}'] | where message contains "${query}" | sort by _time desc | limit ${safeLimit}`;
        result = await queryAxiom(apl);
        break;
      }
      
      case 'logs_errors': {
        const { limit = 5 } = args;
        const safeLimit = Math.min(limit, MAX_LOGS);
        const apl = `['${AXIOM_DATASET}'] | where level == "error" | sort by _time desc | limit ${safeLimit}`;
        result = await queryAxiom(apl);
        break;
      }
      
      case 'logs_timeRange': {
        const { from, to } = args;
        const apl = `['${AXIOM_DATASET}'] | sort by _time desc | limit ${MAX_LOGS}`;
        result = await queryAxiom(apl, from, to);
        break;
      }
      
      case 'logs_byRequest': {
        const { requestId } = args;
        const apl = `['${AXIOM_DATASET}'] | where request_id == "${requestId}" | sort by _time asc | limit ${MAX_LOGS}`;
        result = await queryAxiom(apl);
        break;
      }
      
      case 'logs_stats': {
        const { hours = 24 } = args;
        const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        const apl = `['${AXIOM_DATASET}'] | summarize count() by bin(_time, 1h), level | sort by _time desc`;
        result = await queryAxiom(apl, startTime);
        break;
      }
      
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
    
    res.json(result);
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Axiom MCP HTTP server running on http://localhost:${PORT}`);
  console.log(`Dataset: ${AXIOM_DATASET}`);
  console.log(`API Token: ${AXIOM_API_TOKEN ? 'Set' : 'Not set'}`);
});