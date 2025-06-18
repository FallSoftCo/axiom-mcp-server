#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

// Axiom API configuration
const AXIOM_API_TOKEN = process.env.AXIOM_API_TOKEN || '';
const AXIOM_ORG_ID = process.env.AXIOM_ORG_ID || '';
const AXIOM_DATASET = process.env.AXIOM_DATASET || 'tlyt-logs';
const AXIOM_API_URL = 'https://api.axiom.co/v1';

// Create MCP server
const server = new Server(
  {
    name: 'tlyt-logs-axiom',
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
  console.error('queryAxiom called with:', { apl, startTime, endTime });
  const body = {
    apl: apl,
    startTime: startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    endTime: endTime || new Date().toISOString(),
    includeCursor: false
  };
  console.error('Request body:', JSON.stringify(body, null, 2));

  console.error('Fetching from:', `${AXIOM_API_URL}/datasets/${AXIOM_DATASET}/query`);
  let response;
  try {
    response = await fetch(`${AXIOM_API_URL}/datasets/${AXIOM_DATASET}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    console.error('Fetch error details:', {
      message: error.message,
      cause: error.cause,
      code: error.code,
      stack: error.stack
    });
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Axiom API error: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();
  return data.matches || [];
}

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
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
              description: 'Number of logs to return',
              default: 100
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
          }
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
              description: 'Number of logs to return',
              default: 100
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
              description: 'Number of logs to return',
              default: 100
            }
          }
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
          }
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

// Implement tool handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case 'logs_recent': {
        const limit = request.params.arguments?.limit || 100;
        // Force a very small limit to avoid token issues
        const queryLimit = Math.min(5, limit);
        const apl = `* | sort _time desc | limit ${queryLimit}`;
        const logs = await queryAxiom(apl);
        
        // Truncate log data if it's too large
        const truncatedLogs = logs.map(log => {
          const str = JSON.stringify(log);
          if (str.length > 1000) {
            return {
              ...log,
              _truncated: true,
              _originalSize: str.length,
              message: log.message ? log.message.substring(0, 200) + '...' : undefined,
              data: log.data ? { 
                ...Object.fromEntries(
                  Object.entries(log.data || {}).slice(0, 5)
                ),
                _truncated: true 
              } : undefined
            };
          }
          return log;
        });
        
        return { content: [{ type: 'text', text: JSON.stringify(truncatedLogs, null, 2) }] };
      }
      
      case 'logs_timeRange': {
        const { from, to } = request.params.arguments;
        const apl = `* | sort _time desc`;
        const logs = await queryAxiom(apl, from, to);
        
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_errors': {
        const limit = request.params.arguments?.limit || 100;
        const apl = `* | where level == "error" | sort _time desc | limit ${limit}`;
        const logs = await queryAxiom(apl);
        
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_search': {
        const { query, limit = 100 } = request.params.arguments;
        // Axiom APL uses contains() for text search
        const apl = `* | where contains(message, "${query}") | sort _time desc | limit ${limit}`;
        const logs = await queryAxiom(apl);
        
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_byRequest': {
        const { requestId } = request.params.arguments;
        const apl = `* | where request_id == "${requestId}" | sort _time asc`;
        const logs = await queryAxiom(apl);
        
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_stats': {
        const { hours = 24 } = request.params.arguments;
        const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        const apl = `* | summarize count() by bin(_time, 1h), source, level | sort _time desc`;
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

// Test Axiom connection
async function testConnection() {
  try {
    const response = await fetch(`${AXIOM_API_URL}/datasets`, {
      headers: {
        'Authorization': `Bearer ${AXIOM_API_TOKEN}`,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API test failed: ${response.status}`);
    }
    
    console.error('Axiom API connection successful');
    return true;
  } catch (error) {
    console.error('Error connecting to Axiom:', error.message);
    return false;
  }
}

// Start the server
async function main() {
  console.error('Starting TLYT Logs Axiom MCP server...');
  console.error(`Dataset: ${AXIOM_DATASET}`);
  console.error('API Token:', AXIOM_API_TOKEN ? 'Set' : 'Not set');
  
  if (!AXIOM_API_TOKEN) {
    console.error('ERROR: AXIOM_API_TOKEN environment variable is required');
    console.error('Get your API token from: https://app.axiom.co/settings/profile');
    process.exit(1);
  }
  
  // Test connection
  const connected = await testConnection();
  if (!connected) {
    process.exit(1);
  }
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('TLYT Logs Axiom MCP server started');
}

main().catch(console.error);