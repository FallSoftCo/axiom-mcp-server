#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

// Axiom API configuration
const AXIOM_API_TOKEN = process.env.AXIOM_API_TOKEN || 'xaat-b7d32f2d-76e5-4c44-be33-c702fa2a74a6';
const AXIOM_DELICIOUS_SIENNA_FLUKE_DATASET = process.env.AXIOM_DATASET || 'delicious-sienna-fluke';
const AXIOM_PRODUCTION_DATASET = process.env.AXIOM_PRODUCTION_DATASET || 'delicious-sienna-fluke-production';
const AXIOM_API_URL = 'https://api.axiom.co/v1';
const PORT = process.env.PORT || 3456;

// Database configurations
const DB_CONFIGS = {
  'delicious-sienna-fluke': {
    connectionString: process.env.DATABASE_URL || process.env.DB_DELICIOUS_SIENNA_FLUKE_URL,
    ssl: { rejectUnauthorized: false }
  },
  production: {
    connectionString: process.env.DB_PRODUCTION_URL,
    ssl: { rejectUnauthorized: false }
  }
};

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Create MCP server
const mcpServer = new Server(
  {
    name: 'delicious-sienna-fluke',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper function to escape APL string values
function escapeAPLString(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Database query helper
async function queryDatabase(query, params = [], env = 'delicious-sienna-fluke') {
  const { Pool } = pg;
  const pool = new Pool(DB_CONFIGS[env]);
  
  try {
    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

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
    const error = await response.text();
    throw new Error(`Axiom API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  
  // Validate response structure
  if (!data || !data.matches || !Array.isArray(data.matches)) {
    console.error('Invalid response structure from Axiom:', data);
    return [];
  }
  
  // Transform the data to a simpler format
  // Note: level field is reportedly always null, so not providing a default
  return data.matches.map(entry => ({
    time: entry.data?._time || null,
    message: entry.data?.message || entry.data?.log || 'No message',
    level: entry.data?.level || null,
    source: entry.data?.source || null,
    ...(entry.data || {})
  }));
}

// Axiom field schema documentation
// Based on actual data observed:
// - _time: Timestamp field (sometimes unreliable according to comments)
// - message: Main log content field (primary field)
// - log: Alternative log content field (fallback)
// - level: Log level field (appears to always be null in current data)
// - source: Source of the log
// - metadata.request_id: Request ID for tracing (may not always exist)

// Shared helper functions for logs operations
const logsHelpers = {
  // Default limit to prevent token overflow
  DEFAULT_LIMIT: 100,

  // Get recent logs
  async getRecentLogs(dataset, limit) {
    const apl = `['${dataset}'] | sort by _time desc | limit ${limit}`;
    return await queryAxiom(apl);
  },

  // Search logs by query
  async searchLogs(dataset, query, limit) {
    if (!query) {
      throw new Error('Missing required parameter: query');
    }
    const apl = `['${dataset}'] | where message contains "${escapeAPLString(query)}" | sort by _time desc | limit ${limit}`;
    return await queryAxiom(apl);
  },

  // Get error logs
  async getErrorLogs(dataset, limit) {
    // Search for error patterns in message since level field is always null
    const apl = `['${dataset}'] | where message contains "[error]" or message contains "ERROR" or message contains "Error" or message contains "failed" | sort by _time desc | limit ${limit}`;
    return await queryAxiom(apl);
  },

  // Get logs by time range
  async getLogsByTimeRange(dataset, from, to) {
    if (!from || !to) {
      throw new Error('Missing required parameters: from and to');
    }
    const apl = `['${dataset}'] | sort by _time desc | limit ${this.DEFAULT_LIMIT}`;
    return await queryAxiom(apl, from, to);
  },

  // Get logs by request ID
  async getLogsByRequestId(dataset, requestId) {
    if (!requestId) {
      throw new Error('Missing required parameter: requestId');
    }
    // Note: Using metadata.request_id based on current schema
    const apl = `['${dataset}'] | where metadata.request_id == "${escapeAPLString(requestId)}" | sort by _time asc | limit ${this.DEFAULT_LIMIT}`;
    return await queryAxiom(apl);
  },

  // Get log statistics
  async getLogStats(dataset, hours = 24) {
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const endTime = new Date().toISOString();
    
    // Note: _time field reportedly unreliable, but still using for stats
    const apl = `['${dataset}'] | summarize total_logs = count(), error_logs = countif(message contains "error" or message contains "ERROR"), info_logs = countif(message contains "info"), warning_logs = countif(message contains "warning" or message contains "warn")`;
    const stats = await queryAxiom(apl, startTime, endTime);
    
    return {
      timeRange: { start: startTime, end: endTime, hours },
      stats: stats[0] || { total_logs: 0, error_logs: 0, info_logs: 0, warning_logs: 0 }
    };
  },

  // Delete logs before date
  async deleteLogsBeforeDate(dataset, date) {
    if (!date) {
      throw new Error('Missing required parameter: date');
    }
    
    // Validate date
    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
      throw new Error('Invalid date format');
    }
    
    const durationSeconds = Math.floor((Date.now() - targetDate.getTime()) / 1000);
    if (durationSeconds <= 0) {
      throw new Error('Date must be in the past');
    }
    
    const response = await fetch(`${AXIOM_API_URL}/datasets/${dataset}/trim`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        maxDuration: `${durationSeconds}s`
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete logs: ${response.status} - ${error}`);
    }
    
    return { deleted: true, before: date };
  },

  // Get dataset info
  async getDatasetInfo(dataset) {
    const response = await fetch(`${AXIOM_API_URL}/datasets/${dataset}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${AXIOM_API_TOKEN}`,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get dataset info: ${response.status} - ${error}`);
    }
    
    return await response.json();
  },

  // Clear all logs
  async clearAllLogs(dataset) {
    const response = await fetch(`${AXIOM_API_URL}/datasets/${dataset}/trim`, {
      method: 'POST', 
      headers: {
        'Authorization': `Bearer ${AXIOM_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        maxDuration: '8760h' // 1 year - effectively clears all
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to clear logs: ${response.status} - ${error}`);
    }
    
    return { cleared: true, dataset };
  },

  // Get logs for a specific video by video_id or yt_id
  async getLogsByVideo(dataset, videoId, isYtId = false) {
    if (!videoId) {
      throw new Error('Missing required parameter: videoId');
    }
    
    // Search for video_id or yt_id in log messages
    const searchTerm = isYtId ? `yt_id: ${videoId}` : `video_id: ${videoId}`;
    const apl = `['${dataset}'] | where message contains "${escapeAPLString(searchTerm)}" | sort by _time asc | limit 1000`;
    return await queryAxiom(apl);
  },

  // Get logs for a specific process request
  async getLogsByProcessRequest(dataset, processRequestId) {
    if (!processRequestId) {
      throw new Error('Missing required parameter: processRequestId');
    }
    
    const apl = `['${dataset}'] | where message contains "process_request_id: ${escapeAPLString(processRequestId)}" or message contains "${escapeAPLString(processRequestId)}" | sort by _time asc | limit 1000`;
    return await queryAxiom(apl);
  },

  // Get logs for a specific user
  async getLogsByUser(dataset, userId, hours = 24) {
    if (!userId) {
      throw new Error('Missing required parameter: userId');
    }
    
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const endTime = new Date().toISOString();
    
    const apl = `['${dataset}'] | where message contains "user_id: ${escapeAPLString(userId)}" | sort by _time desc | limit 500`;
    return await queryAxiom(apl, startTime, endTime);
  },

  // Get logs for a specific batch
  async getLogsByBatch(dataset, batchId) {
    if (!batchId) {
      throw new Error('Missing required parameter: batchId');
    }
    
    const apl = `['${dataset}'] | where message contains "batch_id: ${escapeAPLString(batchId)}" | sort by _time asc | limit 1000`;
    return await queryAxiom(apl);
  },

  // Get worker pool activity logs
  async getWorkerLogs(dataset, workerType, hours = 1) {
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const endTime = new Date().toISOString();
    
    let workerFilter = '';
    if (workerType) {
      workerFilter = `and message contains "${escapeAPLString(workerType)}"`;
    }
    
    const apl = `['${dataset}'] | where (message contains "worker" or message contains "Worker") ${workerFilter} | sort by _time desc | limit 500`;
    return await queryAxiom(apl, startTime, endTime);
  },

  // Get processing timeline for a video
  async getVideoProcessingTimeline(dataset, videoId) {
    if (!videoId) {
      throw new Error('Missing required parameter: videoId');
    }
    
    // Get all logs related to this video and extract processing stages
    const apl = `['${dataset}'] | where message contains "${escapeAPLString(videoId)}" | sort by _time asc | limit 2000`;
    const logs = await queryAxiom(apl);
    
    // Group logs by processing stage
    const timeline = {
      videoId,
      stages: [],
      errors: [],
      totalDuration: null
    };
    
    if (logs.length > 0) {
      timeline.startTime = logs[0].time;
      timeline.endTime = logs[logs.length - 1].time;
      timeline.totalDuration = new Date(timeline.endTime) - new Date(timeline.startTime);
      
      // Extract stages and errors
      logs.forEach(log => {
        if (log.message.toLowerCase().includes('error') || log.message.toLowerCase().includes('failed')) {
          timeline.errors.push({
            time: log.time,
            message: log.message
          });
        }
        
        // Look for stage markers in the message
        if (log.message.includes('Starting') || log.message.includes('Processing') || log.message.includes('Completed')) {
          timeline.stages.push({
            time: log.time,
            message: log.message
          });
        }
      });
    }
    
    return timeline;
  },

  // Get failed operations summary
  async getFailedOperations(dataset, hours = 24) {
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const endTime = new Date().toISOString();
    
    const apl = `['${dataset}'] | where message contains "error" or message contains "failed" or message contains "Error" or message contains "Failed" | summarize count() by bin(_time, 1h), message | sort by _time desc`;
    const result = await queryAxiom(apl, startTime, endTime);
    
    // Group errors by type
    const errorSummary = {};
    result.forEach(entry => {
      const errorType = this._extractErrorType(entry.message);
      if (!errorSummary[errorType]) {
        errorSummary[errorType] = {
          count: 0,
          examples: [],
          times: []
        };
      }
      errorSummary[errorType].count += entry['count()'] || 1;
      if (errorSummary[errorType].examples.length < 3) {
        errorSummary[errorType].examples.push(entry.message);
      }
      errorSummary[errorType].times.push(entry._time);
    });
    
    return {
      timeRange: { start: startTime, end: endTime },
      totalErrors: result.reduce((sum, entry) => sum + (entry['count()'] || 1), 0),
      errorTypes: errorSummary
    };
  },

  // Helper to extract error type from message
  _extractErrorType(message) {
    if (message.includes('key :metadata not found')) return 'metadata_missing';
    if (message.includes('constraint error')) return 'constraint_violation';
    if (message.includes('timeout')) return 'timeout';
    if (message.includes('rate limit')) return 'rate_limit';
    if (message.includes('credits')) return 'insufficient_credits';
    if (message.includes('connection')) return 'connection_error';
    return 'unknown';
  }
};

// Define tools for both delicious-sienna-fluke and production
const createToolsForDataset = (dataset, prefix) => [
  {
    name: `${prefix}_recent`,
    description: `Get recent logs from ${dataset}`,
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
    name: `${prefix}_search`,
    description: `Search logs by text in ${dataset}`,
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
      },
      required: ['query']
    }
  },
  {
    name: `${prefix}_errors`,
    description: `Get error logs only from ${dataset}`,
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
    name: `${prefix}_timeRange`,
    description: `Get logs within time range from ${dataset}`,
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start timestamp',
          required: true
        },
        to: {
          type: 'string',
          description: 'End timestamp',
          required: true
        }
      },
      required: ['from', 'to']
    }
  },
  {
    name: `${prefix}_byRequest`,
    description: `Get all logs for a request ID from ${dataset}`,
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
    name: `${prefix}_stats`,
    description: `Get log statistics from ${dataset}`,
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
  },
  {
    name: `${prefix}_deleteBeforeDate`,
    description: `Delete all logs before a specific date from ${dataset}`,
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'ISO date string (logs before this date will be deleted)',
          required: true
        }
      },
      required: ['date']
    }
  },
  {
    name: `${prefix}_getDatasetInfo`,
    description: `Get information about the ${dataset} dataset`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: `${prefix}_clearAll`,
    description: `Clear all logs from the ${dataset} dataset`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: `${prefix}_logsByVideo`,
    description: `Get all logs for a specific video from ${dataset}`,
    inputSchema: {
      type: 'object',
      properties: {
        videoId: {
          type: 'string',
          description: 'Video ID (UUID) or YouTube ID to search for'
        },
        isYtId: {
          type: 'boolean',
          description: 'Set to true if videoId is a YouTube ID',
          default: false
        }
      },
      required: ['videoId']
    }
  },
  {
    name: `${prefix}_logsByProcessRequest`,
    description: `Get all logs for a specific process request from ${dataset}`,
    inputSchema: {
      type: 'object',
      properties: {
        processRequestId: {
          type: 'string',
          description: 'Process request ID (UUID) to search for'
        }
      },
      required: ['processRequestId']
    }
  },
  {
    name: `${prefix}_logsByUser`,
    description: `Get recent logs for a specific user from ${dataset}`,
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description: 'User ID (UUID) to search for'
        },
        hours: {
          type: 'number',
          description: 'Number of hours to look back',
          default: 24
        }
      },
      required: ['userId']
    }
  },
  {
    name: `${prefix}_logsByBatch`,
    description: `Get all logs for a specific batch operation from ${dataset}`,
    inputSchema: {
      type: 'object',
      properties: {
        batchId: {
          type: 'string',
          description: 'Batch ID to search for'
        }
      },
      required: ['batchId']
    }
  },
  {
    name: `${prefix}_workerLogs`,
    description: `Get worker pool activity logs from ${dataset}`,
    inputSchema: {
      type: 'object',
      properties: {
        workerType: {
          type: 'string',
          description: 'Worker type to filter by (youtube, anthropic, pinecone)',
          enum: ['youtube', 'anthropic', 'pinecone']
        },
        hours: {
          type: 'number',
          description: 'Number of hours to look back',
          default: 1
        }
      }
    }
  },
  {
    name: `${prefix}_videoProcessingTimeline`,
    description: `Get complete processing timeline for a video from ${dataset}`,
    inputSchema: {
      type: 'object',
      properties: {
        videoId: {
          type: 'string',
          description: 'Video ID (UUID) to analyze'
        }
      },
      required: ['videoId']
    }
  },
  {
    name: `${prefix}_failedOperations`,
    description: `Get summary of failed operations from ${dataset}`,
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
];

// Database tools
const createDatabaseTools = (env, prefix) => [
  {
    name: `${prefix}_db_videoStats`,
    description: `Get video database statistics from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: `${prefix}_db_processingStatus`,
    description: `Get video processing status summary from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: `${prefix}_db_recentVideos`,
    description: `Get recently added videos from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of videos to return',
          default: 10
        }
      }
    }
  },
  {
    name: `${prefix}_db_videoByYtId`,
    description: `Get video details by YouTube ID from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        ytId: {
          type: 'string',
          description: 'YouTube video ID',
          required: true
        }
      },
      required: ['ytId']
    }
  },
  {
    name: `${prefix}_db_userStats`,
    description: `Get user statistics and credit usage from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: `${prefix}_db_failedJobs`,
    description: `Get failed processing jobs from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of failed jobs to return',
          default: 10
        }
      }
    }
  },
  {
    name: `${prefix}_db_deleteVideos`,
    description: `Delete videos by criteria from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        ytIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of YouTube IDs to delete'
        },
        beforeDate: {
          type: 'string',
          description: 'Delete videos inserted before this date'
        },
        status: {
          type: 'string',
          description: 'Delete videos with specific processing status'
        },
        dryRun: {
          type: 'boolean',
          description: 'If true, show what would be deleted without deleting',
          default: true
        }
      }
    }
  },
  {
    name: `${prefix}_db_channelStats`,
    description: `Get detailed channel statistics from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        channelName: {
          type: 'string',
          description: 'Channel name to analyze (optional, all if not provided)'
        }
      }
    }
  },
  {
    name: `${prefix}_db_processingAnalytics`,
    description: `Get processing time and success rate analytics from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to analyze',
          default: 7
        }
      }
    }
  },
  {
    name: `${prefix}_db_languageAnalytics`,
    description: `Get language distribution and processing success by language from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: `${prefix}_db_errorAnalysis`,
    description: `Analyze error patterns and frequencies from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to analyze',
          default: 30
        }
      }
    }
  },
  {
    name: `${prefix}_db_storageAnalysis`,
    description: `Analyze storage usage and costs from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: `${prefix}_db_userActivity`,
    description: `Get detailed user activity analysis from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description: 'Specific user ID to analyze (optional)'
        },
        days: {
          type: 'number',
          description: 'Number of days to analyze',
          default: 30
        }
      }
    }
  },
  {
    name: `${prefix}_db_cleanupOrphaned`,
    description: `Clean up orphaned process requests from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description: 'If true, show what would be deleted without deleting',
          default: true
        }
      }
    }
  },
  {
    name: `${prefix}_db_retryAllFailed`,
    description: `Retry all failed jobs matching criteria from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'Specific operation to retry (optional)'
        },
        errorPattern: {
          type: 'string',
          description: 'Error message pattern to match (optional)'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of jobs to retry',
          default: 10
        }
      }
    }
  },
  {
    name: `${prefix}_db_retryJob`,
    description: `Retry a failed processing job from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Process request ID to retry',
          required: true
        }
      },
      required: ['jobId']
    }
  },
  {
    name: `${prefix}_db_updateVideoStatus`,
    description: `Update video processing status in ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        videoId: {
          type: 'string',
          description: 'Video ID',
          required: true
        },
        status: {
          type: 'string',
          description: 'New status',
          enum: ['pending', 'processing', 'completed', 'failed'],
          required: true
        }
      },
      required: ['videoId', 'status']
    }
  },
  {
    name: `${prefix}_db_listAnonymousUsers`,
    description: `List anonymous users (users with UUID-based emails) from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of users to return',
          default: 100
        }
      }
    }
  },
  {
    name: `${prefix}_db_deleteAnonymousUsers`,
    description: `Delete anonymous users and all their associated data from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        userIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of user IDs to delete'
        },
        dryRun: {
          type: 'boolean',
          description: 'If true, show what would be deleted without deleting',
          default: true
        }
      }
    }
  },
  {
    name: `${prefix}_db_deleteUserById`,
    description: `Delete a specific user and all associated data by user ID from ${env}`,
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description: 'User ID to delete',
          required: true
        },
        dryRun: {
          type: 'boolean',
          description: 'If true, show what would be deleted without deleting',
          default: true
        }
      },
      required: ['userId']
    }
  }
];

// Handle list tools request
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  const deliciousSiennaFlukeTools = createToolsForDataset(AXIOM_DELICIOUS_SIENNA_FLUKE_DATASET, 'logs');
  const productionTools = createToolsForDataset(AXIOM_PRODUCTION_DATASET, 'prod_logs');
  const deliciousSiennaFlukeDbTools = createDatabaseTools('delicious-sienna-fluke', 'delicious-sienna-fluke');
  const productionDbTools = createDatabaseTools('production', 'prod');
  
  return { 
    // Temporarily disabled production tools
    tools: [...deliciousSiennaFlukeTools, ...deliciousSiennaFlukeDbTools]
    // Original: tools: [...deliciousSiennaFlukeTools, ...productionTools, ...deliciousSiennaFlukeDbTools, ...productionDbTools]
  };
});

// Handle tool calls
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const toolName = request.params.name;
    const args = request.params.arguments || {};
    
    // Determine which dataset to use based on tool prefix
    let dataset = AXIOM_DELICIOUS_SIENNA_FLUKE_DATASET;
    let actualToolName = toolName;
    
    if (toolName.startsWith('prod_logs_')) {
      dataset = AXIOM_PRODUCTION_DATASET;
      actualToolName = toolName.replace('prod_logs_', 'logs_');
    }
    
    switch (actualToolName) {
      case 'logs_recent': {
        const { limit = logsHelpers.DEFAULT_LIMIT } = args;
        const logs = await logsHelpers.getRecentLogs(dataset, limit);
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_search': {
        const { query, limit = logsHelpers.DEFAULT_LIMIT } = args;
        try {
          const logs = await logsHelpers.searchLogs(dataset, query, limit);
          return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_errors': {
        const { limit = logsHelpers.DEFAULT_LIMIT } = args;
        const logs = await logsHelpers.getErrorLogs(dataset, limit);
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      }
      
      case 'logs_timeRange': {
        const { from, to } = args;
        try {
          const logs = await logsHelpers.getLogsByTimeRange(dataset, from, to);
          return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_byRequest': {
        const { requestId } = args;
        try {
          const logs = await logsHelpers.getLogsByRequestId(dataset, requestId);
          return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_stats': {
        const { hours = 24 } = args;
        const result = await logsHelpers.getLogStats(dataset, hours);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      
      case 'logs_deleteBeforeDate': {
        const { date } = args;
        try {
          const result = await logsHelpers.deleteLogsBeforeDate(dataset, date);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_getDatasetInfo': {
        try {
          const info = await logsHelpers.getDatasetInfo(dataset);
          return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_clearAll': {
        try {
          const result = await logsHelpers.clearAllLogs(dataset);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_logsByVideo': {
        const { videoId, isYtId = false } = args;
        try {
          const logs = await logsHelpers.getLogsByVideo(dataset, videoId, isYtId);
          return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_logsByProcessRequest': {
        const { processRequestId } = args;
        try {
          const logs = await logsHelpers.getLogsByProcessRequest(dataset, processRequestId);
          return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_logsByUser': {
        const { userId, hours = 24 } = args;
        try {
          const logs = await logsHelpers.getLogsByUser(dataset, userId, hours);
          return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_logsByBatch': {
        const { batchId } = args;
        try {
          const logs = await logsHelpers.getLogsByBatch(dataset, batchId);
          return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_workerLogs': {
        const { workerType, hours = 1 } = args;
        try {
          const logs = await logsHelpers.getWorkerLogs(dataset, workerType, hours);
          return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_videoProcessingTimeline': {
        const { videoId } = args;
        try {
          const timeline = await logsHelpers.getVideoProcessingTimeline(dataset, videoId);
          return { content: [{ type: 'text', text: JSON.stringify(timeline, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      case 'logs_failedOperations': {
        const { hours = 24 } = args;
        try {
          const result = await logsHelpers.getFailedOperations(dataset, hours);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
        }
      }
      
      // Database tools handling
      if (toolName.startsWith('delicious-sienna-fluke_db_') || toolName.startsWith('prod_db_')) {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const dbToolName = toolName.replace(/^(delicious-sienna-fluke|prod)_db_/, 'db_');
        
        try {
          switch (dbToolName) {
            case 'db_videoStats': {
              const query = `
                WITH video_stats AS (
                  SELECT 
                    COUNT(*) as total_videos,
                    COUNT(DISTINCT yt_id) as unique_videos,
                    COUNT(CASE WHEN current_version > 0 THEN 1 END) as processed_videos,
                    COUNT(CASE WHEN audio_url IS NOT NULL THEN 1 END) as videos_with_audio,
                    COUNT(CASE WHEN frames_extracted = true THEN 1 END) as videos_with_frames,
                    COUNT(CASE WHEN transcript IS NOT NULL THEN 1 END) as videos_with_transcript,
                    COUNT(CASE WHEN embeddings_generated = true THEN 1 END) as videos_with_embeddings,
                    AVG(CASE WHEN duration > 0 THEN duration END)::INTEGER as avg_duration_seconds,
                    SUM(CASE WHEN duration > 0 THEN duration END)::INTEGER as total_duration_seconds,
                    MIN(inserted_at) as first_video_date,
                    MAX(inserted_at) as last_video_date,
                    COUNT(CASE WHEN inserted_at > NOW() - INTERVAL '24 hours' THEN 1 END) as videos_last_24h,
                    COUNT(CASE WHEN inserted_at > NOW() - INTERVAL '7 days' THEN 1 END) as videos_last_7d,
                    COUNT(CASE WHEN inserted_at > NOW() - INTERVAL '30 days' THEN 1 END) as videos_last_30d
                  FROM videos
                ),
                processing_stats AS (
                  SELECT 
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_jobs,
                    COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_jobs,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_jobs,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_jobs
                  FROM process_requests
                ),
                language_stats AS (
                  SELECT 
                    COUNT(DISTINCT language) as unique_languages,
                    MODE() WITHIN GROUP (ORDER BY language) as most_common_language
                  FROM videos
                  WHERE language IS NOT NULL
                ),
                channel_stats AS (
                  SELECT 
                    COUNT(DISTINCT youtube_channel_id) as unique_channels,
                    MODE() WITHIN GROUP (ORDER BY youtube_channel_title) as most_active_channel
                  FROM videos
                  WHERE youtube_channel_id IS NOT NULL
                )
                SELECT 
                  v.*,
                  p.*,
                  l.*,
                  c.*,
                  ROUND(v.processed_videos::NUMERIC / NULLIF(v.total_videos, 0) * 100, 2) as processing_completion_rate,
                  ROUND(v.total_duration_seconds::NUMERIC / 3600, 2) as total_hours_content,
                  ROUND(v.videos_last_24h::NUMERIC / 24, 2) as avg_videos_per_hour_24h
                FROM video_stats v
                CROSS JOIN processing_stats p
                CROSS JOIN language_stats l
                CROSS JOIN channel_stats c
              `;
              const stats = await queryDatabase(query, [], env);
              return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
            }
            
            case 'db_processingStatus': {
              const query = `
                WITH status_summary AS (
                  SELECT 
                    status,
                    COUNT(*) as count,
                    COUNT(DISTINCT video_id) as unique_videos,
                    COUNT(DISTINCT user_id) as unique_users,
                    AVG(retry_count)::NUMERIC(10,2) as avg_retries,
                    MAX(retry_count) as max_retries,
                    MIN(created_at) as oldest_request,
                    MAX(updated_at) as latest_update
                  FROM process_requests
                  GROUP BY status
                ),
                operation_breakdown AS (
                  SELECT 
                    operation,
                    status,
                    COUNT(*) as count
                  FROM process_requests
                  GROUP BY operation, status
                ),
                recent_activity AS (
                  SELECT 
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '1 hour' THEN 1 END) as requests_last_hour,
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as requests_last_24h,
                    COUNT(CASE WHEN status = 'failed' AND updated_at > NOW() - INTERVAL '24 hours' THEN 1 END) as failures_last_24h,
                    COUNT(CASE WHEN status = 'completed' AND updated_at > NOW() - INTERVAL '24 hours' THEN 1 END) as completed_last_24h
                  FROM process_requests
                ),
                queue_status AS (
                  SELECT 
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as queue_size,
                    MIN(CASE WHEN status = 'pending' THEN created_at END) as oldest_pending_request,
                    EXTRACT(EPOCH FROM (NOW() - MIN(CASE WHEN status = 'pending' THEN created_at END)))/60 as oldest_pending_minutes
                  FROM process_requests
                )
                SELECT 
                  json_build_object(
                    'summary', (SELECT json_agg(row_to_json(s)) FROM status_summary s),
                    'by_operation', (SELECT json_agg(json_build_object(
                      'operation', operation,
                      'status', status,
                      'count', count
                    )) FROM operation_breakdown),
                    'recent_activity', (SELECT row_to_json(r) FROM recent_activity r),
                    'queue_status', (SELECT row_to_json(q) FROM queue_status q),
                    'health_indicators', json_build_object(
                      'failure_rate_24h', ROUND(
                        (SELECT failures_last_24h::NUMERIC / NULLIF(requests_last_24h, 0) * 100 FROM recent_activity), 2
                      ),
                      'completion_rate_24h', ROUND(
                        (SELECT completed_last_24h::NUMERIC / NULLIF(requests_last_24h, 0) * 100 FROM recent_activity), 2
                      ),
                      'has_stale_queue', (SELECT oldest_pending_minutes > 60 FROM queue_status)
                    )
                  ) as status_report
              `;
              const status = await queryDatabase(query, [], env);
              return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
            }
            
            case 'db_recentVideos': {
              const { limit = 10 } = args;
              const query = `
                SELECT 
                  id, yt_id, title, uploader as channel_name, duration, 
                  language, current_version, inserted_at
                FROM videos
                ORDER BY inserted_at DESC
                LIMIT $1
              `;
              const videos = await queryDatabase(query, [limit], env);
              return { content: [{ type: 'text', text: JSON.stringify(videos, null, 2) }] };
            }
            
            case 'db_videoByYtId': {
              const { ytId } = args;
              if (!ytId) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required parameter: ytId' }, null, 2) }] };
              }
              const query = `
                SELECT 
                  v.*,
                  pr.status as processing_status,
                  pr.failure_reason as last_error,
                  pr.updated_at as last_processed
                FROM videos v
                LEFT JOIN process_requests pr ON pr.video_id = v.id
                WHERE v.yt_id = $1
                ORDER BY pr.updated_at DESC
                LIMIT 1
              `;
              const video = await queryDatabase(query, [ytId], env);
              return { content: [{ type: 'text', text: JSON.stringify(video, null, 2) }] };
            }
            
            case 'db_userStats': {
              const query = `
                WITH user_summary AS (
                  SELECT 
                    u.id,
                    u.email,
                    u.credits,
                    u.created_at,
                    COUNT(DISTINCT pr.id) as total_requests,
                    COUNT(DISTINCT CASE WHEN pr.status = 'completed' THEN pr.id END) as completed_requests,
                    COUNT(DISTINCT CASE WHEN pr.status = 'failed' THEN pr.id END) as failed_requests,
                    COUNT(DISTINCT pr.video_id) as unique_videos_processed,
                    MAX(pr.created_at) as last_activity,
                    SUM(CASE WHEN pr.created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END) as requests_last_30d
                  FROM users u
                  LEFT JOIN process_requests pr ON pr.user_id = u.id
                  GROUP BY u.id, u.email, u.credits, u.created_at
                ),
                user_segments AS (
                  SELECT 
                    COUNT(CASE WHEN total_requests = 0 THEN 1 END) as inactive_users,
                    COUNT(CASE WHEN total_requests > 0 AND total_requests <= 5 THEN 1 END) as light_users,
                    COUNT(CASE WHEN total_requests > 5 AND total_requests <= 20 THEN 1 END) as moderate_users,
                    COUNT(CASE WHEN total_requests > 20 THEN 1 END) as heavy_users,
                    COUNT(CASE WHEN credits = 0 AND total_requests > 0 THEN 1 END) as users_out_of_credits,
                    COUNT(CASE WHEN last_activity > NOW() - INTERVAL '7 days' THEN 1 END) as active_last_7d,
                    COUNT(CASE WHEN last_activity > NOW() - INTERVAL '30 days' THEN 1 END) as active_last_30d
                  FROM user_summary
                ),
                credit_analysis AS (
                  SELECT 
                    SUM(credits) as total_credits_remaining,
                    AVG(credits)::NUMERIC(10,2) as avg_credits_per_user,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY credits) as median_credits,
                    MIN(credits) as min_credits,
                    MAX(credits) as max_credits,
                    COUNT(CASE WHEN credits < 10 THEN 1 END) as users_low_credits
                  FROM users
                ),
                top_users AS (
                  SELECT 
                    json_agg(json_build_object(
                      'email', email,
                      'total_requests', total_requests,
                      'completed_requests', completed_requests,
                      'credits_remaining', credits,
                      'last_activity', last_activity
                    ) ORDER BY total_requests DESC) as top_10_users
                  FROM (
                    SELECT * FROM user_summary 
                    ORDER BY total_requests DESC 
                    LIMIT 10
                  ) t
                )
                SELECT 
                  json_build_object(
                    'overview', json_build_object(
                      'total_users', (SELECT COUNT(*) FROM users),
                      'total_active_users', (SELECT COUNT(DISTINCT user_id) FROM process_requests),
                      'new_users_last_7d', (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days'),
                      'new_users_last_30d', (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '30 days')
                    ),
                    'user_segments', (SELECT row_to_json(us) FROM user_segments us),
                    'credit_analysis', (SELECT row_to_json(ca) FROM credit_analysis ca),
                    'activity_metrics', json_build_object(
                      'total_videos_processed', (SELECT COUNT(DISTINCT video_id) FROM process_requests WHERE status = 'completed'),
                      'avg_videos_per_active_user', (
                        SELECT AVG(unique_videos_processed)::NUMERIC(10,2) 
                        FROM user_summary 
                        WHERE total_requests > 0
                      ),
                      'total_processing_requests', (SELECT COUNT(*) FROM process_requests),
                      'success_rate', (
                        SELECT ROUND(
                          COUNT(CASE WHEN status = 'completed' THEN 1 END)::NUMERIC / 
                          NULLIF(COUNT(*), 0) * 100, 2
                        ) FROM process_requests
                      )
                    ),
                    'top_users', (SELECT top_10_users FROM top_users)
                  ) as user_statistics
              `;
              const stats = await queryDatabase(query, [], env);
              return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
            }
            
            case 'db_failedJobs': {
              const { limit = 10 } = args;
              const query = `
                SELECT 
                  pr.id,
                  pr.video_id,
                  v.yt_id,
                  v.title,
                  pr.failure_reason as last_error,
                  pr.retry_count,
                  pr.updated_at
                FROM process_requests pr
                JOIN videos v ON v.id = pr.video_id
                WHERE pr.status = 'failed'
                ORDER BY pr.updated_at DESC
                LIMIT $1
              `;
              const jobs = await queryDatabase(query, [limit], env);
              return { content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }] };
            }
            
            case 'db_deleteVideos': {
              const { ytIds, beforeDate, status, dryRun = true } = args;
              let conditions = [];
              let params = [];
              let paramCount = 0;
              
              if (ytIds && ytIds.length > 0) {
                paramCount++;
                conditions.push(`yt_id = ANY($${paramCount})`);
                params.push(ytIds);
              }
              
              if (beforeDate) {
                paramCount++;
                conditions.push(`inserted_at < $${paramCount}`);
                params.push(beforeDate);
              }
              
              if (status) {
                paramCount++;
                conditions.push(`id IN (SELECT video_id FROM process_requests WHERE status = $${paramCount})`);
                params.push(status);
              }
              
              if (conditions.length === 0) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'At least one deletion criteria must be specified' }, null, 2) }] };
              }
              
              const whereClause = conditions.join(' AND ');
              
              if (dryRun) {
                const countQuery = `SELECT COUNT(*) as count, array_agg(yt_id) as sample_yt_ids FROM videos WHERE ${whereClause}`;
                const result = await queryDatabase(countQuery, params, env);
                return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, wouldDelete: result[0] }, null, 2) }] };
              } else {
                const deleteQuery = `DELETE FROM videos WHERE ${whereClause} RETURNING id, yt_id, title`;
                const deleted = await queryDatabase(deleteQuery, params, env);
                return { content: [{ type: 'text', text: JSON.stringify({ deleted: deleted.length, videos: deleted }, null, 2) }] };
              }
            }
            
            case 'db_channelStats': {
              const { channelName } = args;
              let query;
              let params = [];
              
              if (channelName) {
                query = `
                  WITH channel_details AS (
                    SELECT 
                      uploader as channel_name,
                      COUNT(*) as total_videos,
                      COUNT(CASE WHEN current_version > 0 THEN 1 END) as processed_videos,
                      COUNT(CASE WHEN audio_url IS NOT NULL THEN 1 END) as videos_with_audio,
                      COUNT(CASE WHEN frames_extracted = true THEN 1 END) as videos_with_frames,
                      COUNT(CASE WHEN transcript IS NOT NULL THEN 1 END) as videos_with_transcript,
                      COUNT(CASE WHEN embeddings_generated = true THEN 1 END) as videos_with_embeddings,
                      AVG(CASE WHEN duration > 0 THEN duration END)::INTEGER as avg_duration_seconds,
                      SUM(CASE WHEN duration > 0 THEN duration END)::INTEGER as total_duration_seconds,
                      MIN(inserted_at) as first_video_date,
                      MAX(inserted_at) as last_video_date,
                      COUNT(DISTINCT language) as unique_languages,
                      array_agg(DISTINCT language) FILTER (WHERE language IS NOT NULL) as languages,
                      AVG(CASE WHEN transcript IS NOT NULL THEN LENGTH(transcript) ELSE 0 END)::INTEGER as avg_transcript_length,
                      COUNT(CASE WHEN inserted_at > NOW() - INTERVAL '30 days' THEN 1 END) as videos_last_30d
                    FROM videos
                    WHERE uploader = $1
                    GROUP BY uploader
                  ),
                  processing_stats AS (
                    SELECT 
                      COUNT(CASE WHEN pr.status = 'failed' THEN 1 END) as failed_jobs,
                      COUNT(CASE WHEN pr.status = 'pending' THEN 1 END) as pending_jobs,
                      array_agg(DISTINCT pr.failure_reason) FILTER (WHERE pr.failure_reason IS NOT NULL) as failure_reasons
                    FROM process_requests pr
                    JOIN videos v ON v.id = pr.video_id
                    WHERE v.uploader = $1
                  )
                  SELECT 
                    cd.*,
                    ps.failed_jobs,
                    ps.pending_jobs,
                    ps.failure_reasons,
                    ROUND(cd.processed_videos::NUMERIC / NULLIF(cd.total_videos, 0) * 100, 2) as processing_rate,
                    ROUND(cd.total_duration_seconds::NUMERIC / 3600, 2) as total_hours_content,
                    ROUND(cd.videos_last_30d::NUMERIC / 30, 2) as avg_videos_per_day_30d
                  FROM channel_details cd
                  CROSS JOIN processing_stats ps
                `;
                params = [channelName];
              } else {
                query = `
                  WITH channel_summary AS (
                    SELECT 
                      uploader as channel_name,
                      COUNT(*) as total_videos,
                      COUNT(CASE WHEN current_version > 0 THEN 1 END) as processed_videos,
                      AVG(CASE WHEN duration > 0 THEN duration END)::INTEGER as avg_duration_seconds,
                      SUM(CASE WHEN duration > 0 THEN duration END)::INTEGER as total_duration_seconds,
                      MIN(inserted_at) as first_video_date,
                      MAX(inserted_at) as last_video_date,
                      COUNT(CASE WHEN inserted_at > NOW() - INTERVAL '30 days' THEN 1 END) as recent_videos
                    FROM videos
                    WHERE uploader IS NOT NULL
                    GROUP BY uploader
                  )
                  SELECT 
                    channel_name,
                    total_videos,
                    processed_videos,
                    ROUND(processed_videos::NUMERIC / NULLIF(total_videos, 0) * 100, 2) as processing_rate,
                    avg_duration_seconds,
                    ROUND(total_duration_seconds::NUMERIC / 3600, 2) as total_hours,
                    first_video_date,
                    last_video_date,
                    recent_videos,
                    CASE 
                      WHEN recent_videos > 10 THEN 'Very Active'
                      WHEN recent_videos > 5 THEN 'Active'
                      WHEN recent_videos > 0 THEN 'Moderate'
                      ELSE 'Inactive'
                    END as activity_level
                  FROM channel_summary
                  ORDER BY total_videos DESC
                  LIMIT 20
                `;
              }
              
              const stats = await queryDatabase(query, params, env);
              return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
            }
            
            case 'db_processingAnalytics': {
              const { days = 7 } = args;
              const query = `
                WITH processing_times AS (
                  SELECT 
                    pr.status,
                    pr.inserted_at,
                    pr.updated_at,
                    pr.retry_count,
                    EXTRACT(EPOCH FROM (pr.updated_at - pr.inserted_at)) as processing_seconds,
                    DATE_TRUNC('day', pr.inserted_at) as processing_date,
                    EXTRACT(HOUR FROM pr.inserted_at) as processing_hour
                  FROM process_requests pr
                  WHERE pr.inserted_at > NOW() - INTERVAL '${days} days'
                ),
                overall_metrics AS (
                  SELECT 
                    COUNT(*) as total_jobs,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
                    COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
                    ROUND(COUNT(CASE WHEN status = 'completed' THEN 1 END)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 2) as success_rate,
                    AVG(CASE WHEN status = 'completed' THEN processing_seconds END)::INTEGER as avg_success_time_seconds,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CASE WHEN status = 'completed' THEN processing_seconds END) as median_success_time_seconds,
                    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY CASE WHEN status = 'completed' THEN processing_seconds END) as p95_success_time_seconds,
                    MAX(CASE WHEN status = 'completed' THEN processing_seconds END)::INTEGER as max_success_time_seconds,
                    MIN(CASE WHEN status = 'completed' THEN processing_seconds END)::INTEGER as min_success_time_seconds,
                    AVG(retry_count)::NUMERIC(10,2) as avg_retries,
                    MAX(retry_count) as max_retries
                  FROM processing_times
                ),
                daily_trends AS (
                  SELECT 
                    processing_date,
                    COUNT(*) as daily_jobs,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as daily_completed,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as daily_failed,
                    ROUND(AVG(CASE WHEN status = 'completed' THEN processing_seconds END)::NUMERIC, 2) as avg_daily_processing_time
                  FROM processing_times
                  GROUP BY processing_date
                  ORDER BY processing_date DESC
                ),
                hourly_distribution AS (
                  SELECT 
                    processing_hour,
                    COUNT(*) as jobs_count,
                    ROUND(COUNT(CASE WHEN status = 'completed' THEN 1 END)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 2) as hourly_success_rate
                  FROM processing_times
                  GROUP BY processing_hour
                  ORDER BY processing_hour
                ),
                video_complexity AS (
                  SELECT 
                    CASE 
                      WHEN v.duration < 300 THEN 'Short (< 5 min)'
                      WHEN v.duration < 900 THEN 'Medium (5-15 min)'
                      WHEN v.duration < 1800 THEN 'Long (15-30 min)'
                      ELSE 'Very Long (> 30 min)'
                    END as duration_category,
                    COUNT(pr.id) as jobs_count,
                    ROUND(COUNT(CASE WHEN pr.status = 'completed' THEN 1 END)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 2) as success_rate,
                    AVG(EXTRACT(EPOCH FROM (pr.updated_at - pr.inserted_at)))::INTEGER as avg_processing_seconds
                  FROM process_requests pr
                  JOIN videos v ON v.id = pr.video_id
                  WHERE pr.inserted_at > NOW() - INTERVAL '${days} days'
                    AND v.duration > 0
                  GROUP BY duration_category
                )
                SELECT 
                  json_build_object(
                    'overall_metrics', (SELECT row_to_json(om) FROM overall_metrics om),
                    'daily_trends', (SELECT json_agg(row_to_json(dt)) FROM daily_trends dt),
                    'hourly_distribution', (SELECT json_agg(row_to_json(hd)) FROM hourly_distribution hd),
                    'video_complexity_impact', (SELECT json_agg(row_to_json(vc)) FROM video_complexity vc),
                    'summary', json_build_object(
                      'total_jobs', (SELECT total_jobs FROM overall_metrics),
                      'overall_success_rate', (SELECT success_rate FROM overall_metrics),
                      'avg_processing_time_minutes', (SELECT ROUND(avg_success_time_seconds::NUMERIC / 60, 2) FROM overall_metrics),
                      'busiest_hour', (SELECT processing_hour FROM hourly_distribution ORDER BY jobs_count DESC LIMIT 1),
                      'quietest_hour', (SELECT processing_hour FROM hourly_distribution ORDER BY jobs_count ASC LIMIT 1)
                    )
                  ) as analytics_report
              `;
              const analytics = await queryDatabase(query, [], env);
              return { content: [{ type: 'text', text: JSON.stringify(analytics, null, 2) }] };
            }
            
            case 'db_languageAnalytics': {
              const query = `
                WITH language_stats AS (
                  SELECT 
                    COALESCE(v.language, 'en') as language,
                    COUNT(DISTINCT v.id) as total_videos,
                    COUNT(DISTINCT CASE WHEN v.current_version > 0 THEN v.id END) as processed_videos,
                    COUNT(DISTINCT v.youtube_channel_id) as unique_channels,
                    AVG(CASE WHEN v.duration > 0 THEN v.duration END)::INTEGER as avg_duration_seconds,
                    SUM(CASE WHEN v.duration > 0 THEN v.duration END)::INTEGER as total_duration_seconds,
                    COUNT(DISTINCT CASE WHEN v.transcript IS NOT NULL THEN v.id END) as videos_with_transcript,
                    COUNT(DISTINCT CASE WHEN v.audio_url IS NOT NULL THEN v.id END) as videos_with_audio,
                    COUNT(DISTINCT CASE WHEN v.frames_extracted = true THEN v.id END) as videos_with_frames,
                    COUNT(DISTINCT CASE WHEN v.embeddings_generated = true THEN v.id END) as videos_with_embeddings,
                    MIN(v.inserted_at) as first_video_date,
                    MAX(v.inserted_at) as last_video_date,
                    COUNT(CASE WHEN v.inserted_at > NOW() - INTERVAL '30 days' THEN 1 END) as videos_last_30d,
                    COUNT(CASE WHEN v.inserted_at > NOW() - INTERVAL '7 days' THEN 1 END) as videos_last_7d
                  FROM videos v
                  GROUP BY COALESCE(v.language, 'en')
                ),
                processing_stats AS (
                  SELECT 
                    COALESCE(v.language, 'en') as language,
                    COUNT(DISTINCT CASE WHEN pr.status = 'failed' THEN v.id END) as failed_videos,
                    COUNT(DISTINCT CASE WHEN pr.status = 'pending' THEN v.id END) as pending_videos,
                    COUNT(DISTINCT pr.id) as total_processing_attempts,
                    AVG(pr.retry_count) as avg_retries,
                    array_agg(DISTINCT pr.failure_reason) FILTER (WHERE pr.failure_reason IS NOT NULL) as common_errors
                  FROM videos v
                  LEFT JOIN process_requests pr ON pr.video_id = v.id
                  GROUP BY COALESCE(v.language, 'en')
                ),
                language_trends AS (
                  SELECT 
                    COALESCE(language, 'en') as language,
                    DATE_TRUNC('month', inserted_at) as month,
                    COUNT(*) as monthly_videos
                  FROM videos
                  WHERE inserted_at > NOW() - INTERVAL '6 months'
                  GROUP BY COALESCE(language, 'en'), DATE_TRUNC('month', inserted_at)
                ),
                top_channels_by_language AS (
                  SELECT 
                    COALESCE(language, 'en') as language,
                    youtube_channel_title,
                    COUNT(*) as channel_videos,
                    ROW_NUMBER() OVER (PARTITION BY COALESCE(language, 'en') ORDER BY COUNT(*) DESC) as rank
                  FROM videos
                  WHERE youtube_channel_title IS NOT NULL
                  GROUP BY COALESCE(language, 'en'), youtube_channel_title
                )
                SELECT 
                  json_build_object(
                    'language_summary', (
                      SELECT json_agg(json_build_object(
                        'language', ls.language,
                        'total_videos', ls.total_videos,
                        'processed_videos', ls.processed_videos,
                        'processing_rate', ROUND(ls.processed_videos::NUMERIC / NULLIF(ls.total_videos, 0) * 100, 2),
                        'unique_channels', ls.unique_channels,
                        'avg_duration_seconds', ls.avg_duration_seconds,
                        'total_hours_content', ROUND(ls.total_duration_seconds::NUMERIC / 3600, 2),
                        'videos_with_transcript', ls.videos_with_transcript,
                        'transcript_rate', ROUND(ls.videos_with_transcript::NUMERIC / NULLIF(ls.total_videos, 0) * 100, 2),
                        'failed_videos', ps.failed_videos,
                        'failure_rate', ROUND(ps.failed_videos::NUMERIC / NULLIF(ls.total_videos, 0) * 100, 2),
                        'growth_last_30d', ls.videos_last_30d,
                        'growth_last_7d', ls.videos_last_7d,
                        'is_active', ls.videos_last_7d > 0
                      ) ORDER BY ls.total_videos DESC)
                      FROM language_stats ls
                      LEFT JOIN processing_stats ps ON ps.language = ls.language
                    ),
                    'growth_trends', (
                      SELECT json_agg(json_build_object(
                        'language', language,
                        'month', month,
                        'videos', monthly_videos
                      ) ORDER BY language, month)
                      FROM language_trends
                    ),
                    'top_channels_per_language', (
                      SELECT json_agg(json_build_object(
                        'language', language,
                        'channel', youtube_channel_title,
                        'videos', channel_videos
                      ) ORDER BY language, rank)
                      FROM top_channels_by_language
                      WHERE rank <= 3
                    ),
                    'summary', json_build_object(
                      'total_languages', (SELECT COUNT(DISTINCT language) FROM language_stats),
                      'most_popular_language', (SELECT language FROM language_stats ORDER BY total_videos DESC LIMIT 1),
                      'highest_processing_rate_language', (
                        SELECT language 
                        FROM language_stats 
                        WHERE total_videos > 10
                        ORDER BY processed_videos::NUMERIC / NULLIF(total_videos, 0) DESC 
                        LIMIT 1
                      ),
                      'total_multilingual_channels', (
                        SELECT COUNT(DISTINCT youtube_channel_id) 
                        FROM (
                          SELECT youtube_channel_id
                          FROM videos
                          WHERE youtube_channel_id IS NOT NULL
                          GROUP BY youtube_channel_id
                          HAVING COUNT(DISTINCT language) > 1
                        ) mc
                      )
                    )
                  ) as language_analytics
              `;
              const analytics = await queryDatabase(query, [], env);
              return { content: [{ type: 'text', text: JSON.stringify(analytics, null, 2) }] };
            }
            
            case 'db_errorAnalysis': {
              const { days = 30 } = args;
              const query = `
                SELECT 
                  COALESCE(failure_reason, 'Unknown Error') as error_type,
                  COUNT(*) as occurrences,
                  COUNT(DISTINCT video_id) as affected_videos,
                  MAX(updated_at) as last_occurrence,
                  MIN(updated_at) as first_occurrence
                FROM process_requests
                WHERE status = 'failed'
                  AND updated_at > NOW() - INTERVAL '${days} days'
                  AND failure_reason IS NOT NULL
                GROUP BY failure_reason
                ORDER BY occurrences DESC
                LIMIT 20
              `;
              const analysis = await queryDatabase(query, [], env);
              return { content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }] };
            }
            
            case 'db_storageAnalysis': {
              const query = `
                SELECT 
                  'Total Storage' as category,
                  COUNT(*) as count,
                  ROUND((
                    COUNT(CASE WHEN audio_url IS NOT NULL THEN 1 END) * 5 +
                    COUNT(CASE WHEN frames_extracted = true THEN 1 END) * 10 * 0.1 +
                    COUNT(CASE WHEN transcript IS NOT NULL THEN 1 END) * 0.001 +
                    COUNT(CASE WHEN embeddings_generated = true THEN 1 END) * 0.004
                  )::NUMERIC, 2) as estimated_mb,
                  ROUND((
                    COUNT(CASE WHEN audio_url IS NOT NULL THEN 1 END) * 5 +
                    COUNT(CASE WHEN frames_extracted = true THEN 1 END) * 10 * 0.1 +
                    COUNT(CASE WHEN transcript IS NOT NULL THEN 1 END) * 0.001 +
                    COUNT(CASE WHEN embeddings_generated = true THEN 1 END) * 0.004
                  )::NUMERIC * 0.023 / 1024, 4) as estimated_cost_usd
                FROM videos
                UNION ALL
                SELECT 
                  'Audio Files' as category,
                  COUNT(*) as count,
                  COUNT(*) * 5 as estimated_mb,
                  ROUND(COUNT(*) * 5 * 0.023 / 1024, 4) as estimated_cost_usd
                FROM videos WHERE audio_url IS NOT NULL
                UNION ALL
                SELECT 
                  'Frame Images' as category,
                  COUNT(*) * 10 as count,
                  ROUND(COUNT(*) * 10 * 0.1, 2) as estimated_mb,
                  ROUND(COUNT(*) * 10 * 0.1 * 0.023 / 1024, 4) as estimated_cost_usd
                FROM videos WHERE frames_extracted = true
                UNION ALL
                SELECT 
                  'Transcripts' as category,
                  COUNT(*) as count,
                  ROUND(SUM(LENGTH(transcript))::NUMERIC / 1024 / 1024, 2) as estimated_mb,
                  ROUND(SUM(LENGTH(transcript))::NUMERIC / 1024 / 1024 * 0.023 / 1024, 4) as estimated_cost_usd
                FROM videos WHERE transcript IS NOT NULL
              `;
              const storage = await queryDatabase(query, [], env);
              return { content: [{ type: 'text', text: JSON.stringify(storage, null, 2) }] };
            }
            
            case 'db_userActivity': {
              const { userId, days = 30 } = args;
              let query;
              let params = [];
              
              if (userId) {
                query = `
                  SELECT 
                    u.id,
                    u.email,
                    u.credits,
                    COUNT(DISTINCT pr.video_id) as videos_requested,
                    COUNT(DISTINCT CASE WHEN pr.status = 'completed' THEN pr.video_id END) as videos_completed,
                    COUNT(DISTINCT DATE(pr.created_at)) as active_days,
                    MIN(pr.created_at) as first_activity,
                    MAX(pr.created_at) as last_activity,
                    array_agg(DISTINCT pr.operation) as operations_used
                  FROM users u
                  LEFT JOIN process_requests pr ON pr.user_id = u.id
                  WHERE u.id = $1
                    AND (pr.created_at IS NULL OR pr.created_at > NOW() - INTERVAL '${days} days')
                  GROUP BY u.id, u.email, u.credits
                `;
                params = [userId];
              } else {
                query = `
                  SELECT 
                    u.id,
                    u.email,
                    u.credits,
                    COUNT(DISTINCT pr.video_id) as videos_requested_period,
                    COUNT(DISTINCT CASE WHEN pr.status = 'completed' THEN pr.video_id END) as videos_completed_period,
                    MAX(pr.created_at) as last_activity
                  FROM users u
                  LEFT JOIN process_requests pr ON pr.user_id = u.id
                    AND pr.created_at > NOW() - INTERVAL '${days} days'
                  GROUP BY u.id, u.email, u.credits
                  HAVING COUNT(pr.id) > 0
                  ORDER BY videos_requested_period DESC
                  LIMIT 20
                `;
              }
              
              const activity = await queryDatabase(query, params, env);
              return { content: [{ type: 'text', text: JSON.stringify(activity, null, 2) }] };
            }
            
            case 'db_cleanupOrphaned': {
              const { dryRun = true } = args;
              
              if (dryRun) {
                const query = `
                  SELECT COUNT(*) as orphaned_count
                  FROM process_requests pr
                  WHERE NOT EXISTS (
                    SELECT 1 FROM videos v WHERE v.id = pr.video_id
                  )
                `;
                const result = await queryDatabase(query, [], env);
                return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, orphanedRequests: result[0].orphaned_count }, null, 2) }] };
              } else {
                const deleteQuery = `
                  DELETE FROM process_requests
                  WHERE NOT EXISTS (
                    SELECT 1 FROM videos v WHERE v.id = process_requests.video_id
                  )
                  RETURNING id, video_id, operation
                `;
                const deleted = await queryDatabase(deleteQuery, [], env);
                return { content: [{ type: 'text', text: JSON.stringify({ deleted: deleted.length, requests: deleted }, null, 2) }] };
              }
            }
            
            case 'db_retryAllFailed': {
              const { errorPattern, limit = 10 } = args;
              let conditions = ['pr.status = \'failed\''];
              let params = [];
              let paramCount = 0;
              
              if (errorPattern) {
                paramCount++;
                conditions.push(`pr.failure_reason LIKE $${paramCount}`);
                params.push(`%${errorPattern}%`);
              }
              
              paramCount++;
              params.push(limit);
              
              const updateQuery = `
                UPDATE process_requests pr
                SET 
                  status = 'pending',
                  retry_count = retry_count + 1,
                  failure_reason = NULL,
                  updated_at = NOW()
                WHERE pr.id IN (
                  SELECT id
                  FROM process_requests
                  WHERE ${conditions.join(' AND ')}
                  ORDER BY updated_at DESC
                  LIMIT $${paramCount}
                )
                RETURNING pr.id, pr.video_id, pr.retry_count
              `;
              
              const retried = await queryDatabase(updateQuery, params, env);
              return { content: [{ type: 'text', text: JSON.stringify({ retried: retried.length, jobs: retried }, null, 2) }] };
            }
            
            case 'listAnonymousUsers': {
              const { limit = 100 } = args;
              
              const query = `
                SELECT 
                  u.id,
                  u.email,
                  u.credits,
                  COUNT(DISTINCT pr.id) as process_request_count,
                  COUNT(DISTINCT pr.video_id) as unique_videos_processed,
                  COUNT(CASE WHEN pr.status = 'completed' THEN 1 END) as completed_requests,
                  COUNT(CASE WHEN pr.status = 'failed' THEN 1 END) as failed_requests,
                  MIN(pr.inserted_at) as first_request,
                  MAX(pr.inserted_at) as last_request
                FROM users u
                LEFT JOIN process_requests pr ON pr.user_id = u.id
                WHERE u.email LIKE 'user_%@%'
                GROUP BY u.id, u.email, u.credits
                ORDER BY u.inserted_at DESC
                LIMIT $1
              `;
              
              const users = await queryDatabase(query, [limit], env);
              return { content: [{ type: 'text', text: JSON.stringify(users, null, 2) }] };
            }
            
            case 'deleteAnonymousUsers': {
              const { userIds, dryRun = true } = args;
              let targetUserIds = userIds;
              
              if (!targetUserIds || targetUserIds.length === 0) {
                // If no user IDs specified, find all anonymous users
                const findQuery = `
                  SELECT id FROM users 
                  WHERE email LIKE 'user_%@%'
                `;
                const anonymousUsers = await queryDatabase(findQuery, [], env);
                targetUserIds = anonymousUsers.map(u => u.id);
              }
              
              if (dryRun) {
                // Show what would be deleted
                const infoQuery = `
                  SELECT 
                    u.id,
                    u.email,
                    COUNT(DISTINCT pr.id) as process_requests_to_delete,
                    COUNT(DISTINCT v.id) as videos_to_delete
                  FROM users u
                  LEFT JOIN process_requests pr ON pr.user_id = u.id
                  LEFT JOIN videos v ON v.id = pr.video_id
                  WHERE u.id = ANY($1)
                  GROUP BY u.id, u.email
                `;
                const info = await queryDatabase(infoQuery, [targetUserIds], env);
                return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, wouldDelete: info }, null, 2) }] };
              } else {
                // Actually delete - videos will cascade delete process_requests
                const deleteVideosQuery = `
                  DELETE FROM videos 
                  WHERE id IN (
                    SELECT DISTINCT video_id 
                    FROM process_requests 
                    WHERE user_id = ANY($1)
                  )
                  RETURNING id, yt_id, title
                `;
                const deletedVideos = await queryDatabase(deleteVideosQuery, [targetUserIds], env);
                
                // Delete users
                const deleteUsersQuery = `
                  DELETE FROM users 
                  WHERE id = ANY($1)
                  RETURNING id, email
                `;
                const deletedUsers = await queryDatabase(deleteUsersQuery, [targetUserIds], env);
                
                return { content: [{ type: 'text', text: JSON.stringify({ 
                  dryRun: false, 
                  deleted: {
                    users: deletedUsers,
                    videos: deletedVideos
                  }
                }, null, 2) }] };
              }
            }
            
            case 'deleteUserById': {
              const { userId, dryRun = true } = args;
              
              if (!userId) {
                throw new Error('Missing required parameter: userId');
              }
              
              if (dryRun) {
                // Show what would be deleted
                const infoQuery = `
                  SELECT 
                    u.id,
                    u.email,
                    u.credits,
                    COUNT(DISTINCT pr.id) as process_requests_to_delete,
                    COUNT(DISTINCT v.id) as videos_to_delete
                  FROM users u
                  LEFT JOIN process_requests pr ON pr.user_id = u.id
                  LEFT JOIN videos v ON v.id = pr.video_id
                  WHERE u.id = $1
                  GROUP BY u.id, u.email, u.credits
                `;
                const info = await queryDatabase(infoQuery, [userId], env);
                return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, wouldDelete: info[0] || null }, null, 2) }] };
              } else {
                // Actually delete - videos will cascade delete process_requests
                const deleteVideosQuery = `
                  DELETE FROM videos 
                  WHERE id IN (
                    SELECT DISTINCT video_id 
                    FROM process_requests 
                    WHERE user_id = $1
                  )
                  RETURNING id, yt_id, title
                `;
                const deletedVideos = await queryDatabase(deleteVideosQuery, [userId], env);
                
                // Delete user
                const deleteUserQuery = `
                  DELETE FROM users 
                  WHERE id = $1
                  RETURNING id, email, credits
                `;
                const deletedUser = await queryDatabase(deleteUserQuery, [userId], env);
                
                return { content: [{ type: 'text', text: JSON.stringify({ 
                  dryRun: false, 
                  deleted: {
                    user: deletedUser[0] || null,
                    videos: deletedVideos
                  }
                }, null, 2) }] };
              }
            }
            
            default:
              throw new Error(`Unknown database tool: ${dbToolName}`);
          }
        } catch (dbError) {
          console.error('Database tool error:', dbError);
          return { content: [{ type: 'text', text: JSON.stringify({ error: dbError.message }, null, 2) }] };
        }
      }
      
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    console.error('Tool execution error:', error);
    return { 
      content: [{ 
        type: 'text', 
        text: JSON.stringify({ error: error.message || 'Unknown error' }, null, 2) 
      }] 
    };
  }
});

// SSE endpoint for Claude Desktop
app.get('/sse', (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  mcpServer.connect(transport);
  console.log('Client connected via SSE');
});

// API endpoint for MCP tools
app.post('/api/mcp/:toolName', async (req, res) => {
  try {
    const toolName = req.params.toolName;
    const args = req.body || {};
    
    // Determine which dataset to use based on tool prefix
    let dataset = AXIOM_DELICIOUS_SIENNA_FLUKE_DATASET;
    let actualToolName = toolName;
    
    if (toolName.startsWith('prod_logs_')) {
      dataset = AXIOM_PRODUCTION_DATASET;
      actualToolName = toolName.replace('prod_logs_', 'logs_');
    }
    
    switch (actualToolName) {
      case 'logs_recent': {
        const { limit = logsHelpers.DEFAULT_LIMIT } = args;
        const logs = await logsHelpers.getRecentLogs(dataset, limit);
        res.json(logs);
        break;
      }
      
      case 'logs_search': {
        const { query, limit = logsHelpers.DEFAULT_LIMIT } = args;
        try {
          const logs = await logsHelpers.searchLogs(dataset, query, limit);
          res.json(logs);
        } catch (error) {
          res.status(400).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_errors': {
        const { limit = logsHelpers.DEFAULT_LIMIT } = args;
        const logs = await logsHelpers.getErrorLogs(dataset, limit);
        res.json(logs);
        break;
      }
      
      case 'logs_timeRange': {
        const { from, to } = args;
        try {
          const logs = await logsHelpers.getLogsByTimeRange(dataset, from, to);
          res.json(logs);
        } catch (error) {
          res.status(400).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_byRequest': {
        const { requestId } = args;
        try {
          const logs = await logsHelpers.getLogsByRequestId(dataset, requestId);
          res.json(logs);
        } catch (error) {
          res.status(400).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_stats': {
        const { hours = 24 } = args;
        const result = await logsHelpers.getLogStats(dataset, hours);
        res.json(result);
        break;
      }
      
      case 'logs_deleteBeforeDate': {
        const { date } = args;
        try {
          const result = await logsHelpers.deleteLogsBeforeDate(dataset, date);
          res.json(result);
        } catch (error) {
          res.status(400).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_getDatasetInfo': {
        try {
          const info = await logsHelpers.getDatasetInfo(dataset);
          res.json(info);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_clearAll': {
        try {
          const result = await logsHelpers.clearAllLogs(dataset);
          res.json(result);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_logsByVideo': {
        const { videoId, isYtId = false } = args;
        try {
          const logs = await logsHelpers.getLogsByVideo(dataset, videoId, isYtId);
          res.json(logs);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_logsByProcessRequest': {
        const { processRequestId } = args;
        try {
          const logs = await logsHelpers.getLogsByProcessRequest(dataset, processRequestId);
          res.json(logs);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_logsByUser': {
        const { userId, hours = 24 } = args;
        try {
          const logs = await logsHelpers.getLogsByUser(dataset, userId, hours);
          res.json(logs);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_logsByBatch': {
        const { batchId } = args;
        try {
          const logs = await logsHelpers.getLogsByBatch(dataset, batchId);
          res.json(logs);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_workerLogs': {
        const { workerType, hours = 1 } = args;
        try {
          const logs = await logsHelpers.getWorkerLogs(dataset, workerType, hours);
          res.json(logs);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_videoProcessingTimeline': {
        const { videoId } = args;
        try {
          const timeline = await logsHelpers.getVideoProcessingTimeline(dataset, videoId);
          res.json(timeline);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
        break;
      }
      
      case 'logs_failedOperations': {
        const { hours = 24 } = args;
        try {
          const result = await logsHelpers.getFailedOperations(dataset, hours);
          res.json(result);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
        break;
      }
      
      // Database tools handling
      case 'delicious-sienna-fluke_db_videoStats':
      case 'prod_db_videoStats': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const query = `
          SELECT 
            COUNT(*) as total_videos,
            COUNT(DISTINCT yt_id) as unique_videos,
            COUNT(CASE WHEN current_version > 0 THEN 1 END) as processed_videos,
            COUNT(CASE WHEN audio_url IS NOT NULL THEN 1 END) as videos_with_audio,
            COUNT(CASE WHEN frames_extracted = true THEN 1 END) as videos_with_frames,
            COUNT(CASE WHEN transcript IS NOT NULL THEN 1 END) as videos_with_transcript,
            AVG(duration)::INTEGER as avg_duration_seconds
          FROM videos
        `;
        const stats = await queryDatabase(query, [], env);
        res.json(stats);
        break;
      }
      
      case 'delicious-sienna-fluke_db_processingStatus':
      case 'prod_db_processingStatus': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const query = `
          SELECT 
            status,
            COUNT(*) as count
          FROM process_requests
          GROUP BY status
          ORDER BY count DESC
        `;
        const status = await queryDatabase(query, [], env);
        res.json(status);
        break;
      }
      
      case 'delicious-sienna-fluke_db_recentVideos':
      case 'prod_db_recentVideos': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { limit = 10 } = args;
        const query = `
          SELECT 
            id, yt_id, title, uploader as channel_name, duration, 
            language, current_version, inserted_at
          FROM videos
          ORDER BY inserted_at DESC
          LIMIT $1
        `;
        const videos = await queryDatabase(query, [limit], env);
        res.json(videos);
        break;
      }
      
      case 'delicious-sienna-fluke_db_videoByYtId':
      case 'prod_db_videoByYtId': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { ytId } = args;
        if (!ytId) {
          res.status(400).json({ error: 'Missing required parameter: ytId' });
          break;
        }
        
        const query = `
          SELECT 
            v.*,
            pr.status as processing_status,
            pr.failure_reason as last_error,
            pr.updated_at as last_processed
          FROM videos v
          LEFT JOIN process_requests pr ON pr.video_id = v.id
          WHERE v.yt_id = $1
          ORDER BY pr.updated_at DESC
          LIMIT 1
        `;
        const video = await queryDatabase(query, [ytId], env);
        res.json(video);
        break;
      }
      
      case 'delicious-sienna-fluke_db_userStats':
      case 'prod_db_userStats': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const query = `
          SELECT 
            COUNT(DISTINCT u.id) as total_users,
            COUNT(DISTINCT CASE WHEN u.credits > 0 THEN u.id END) as users_with_credits,
            COUNT(DISTINCT pr.user_id) as active_users,
            SUM(u.credits) as total_credits_remaining,
            (SELECT COUNT(*) FROM process_requests WHERE status = 'completed') / NULLIF(COUNT(DISTINCT u.id), 0) as avg_videos_per_user
          FROM users u
          LEFT JOIN process_requests pr ON pr.user_id = u.id
        `;
        const stats = await queryDatabase(query, [], env);
        res.json(stats);
        break;
      }
      
      case 'delicious-sienna-fluke_db_failedJobs':
      case 'prod_db_failedJobs': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { limit = 10 } = args;
        const query = `
          SELECT 
            pr.id,
            pr.video_id,
            v.yt_id,
            v.title,
            pr.failure_reason as last_error,
            pr.retry_count,
            pr.updated_at
          FROM process_requests pr
          JOIN videos v ON v.id = pr.video_id
          WHERE pr.status = 'failed'
          ORDER BY pr.updated_at DESC
          LIMIT $1
        `;
        const jobs = await queryDatabase(query, [limit], env);
        res.json(jobs);
        break;
      }
      
      case 'delicious-sienna-fluke_db_retryJob':
      case 'prod_db_retryJob': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { jobId } = args;
        if (!jobId) {
          res.status(400).json({ error: 'Missing required parameter: jobId' });
          break;
        }
        
        const query = `
          UPDATE process_requests
          SET 
            status = 'pending',
            retry_count = retry_count + 1,
            failure_reason = NULL,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `;
        const result = await queryDatabase(query, [jobId], env);
        res.json(result);
        break;
      }
      
      case 'delicious-sienna-fluke_db_updateVideoStatus':
      case 'prod_db_updateVideoStatus': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { videoId, status } = args;
        if (!videoId || !status) {
          res.status(400).json({ error: 'Missing required parameters: videoId and status' });
          break;
        }
        
        const query = `
          UPDATE videos
          SET 
            updated_at = NOW()
          WHERE id = $1
          RETURNING id, yt_id, title, updated_at
        `;
        const video = await queryDatabase(query, [videoId], env);
        
        // Also update process request if exists
        const prQuery = `
          UPDATE process_requests
          SET 
            status = $2,
            updated_at = NOW()
          WHERE video_id = $1
          RETURNING *
        `;
        const pr = await queryDatabase(prQuery, [videoId, status], env);
        
        res.json({ video: video[0], processRequest: pr[0] });
        break;
      }
      
      
      case 'delicious-sienna-fluke_db_deleteVideos':
      case 'prod_db_deleteVideos': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { ytIds, status, beforeDate, dryRun = true } = args;
        
        let query = 'DELETE FROM videos WHERE ';
        let params = [];
        let conditions = [];
        
        if (ytIds && ytIds.length > 0) {
          conditions.push(`yt_id = ANY($${params.length + 1})`);
          params.push(ytIds);
        }
        
        if (status) {
          const prSubquery = 'EXISTS (SELECT 1 FROM process_requests pr WHERE pr.video_id = videos.id AND pr.status = $' + (params.length + 1) + ')';
          conditions.push(prSubquery);
          params.push(status);
        }
        
        if (beforeDate) {
          conditions.push(`inserted_at < $${params.length + 1}`);
          params.push(beforeDate);
        }
        
        if (conditions.length === 0) {
          res.status(400).json({ error: 'Must specify at least one deletion criteria' });
          break;
        }
        
        query += conditions.join(' AND ');
        
        if (dryRun) {
          const countQuery = query.replace('DELETE FROM videos', 'SELECT COUNT(*) as count FROM videos');
          const result = await queryDatabase(countQuery, params, env);
          res.json({ dryRun: true, wouldDelete: parseInt(result[0].count) });
        } else {
          query += ' RETURNING id, yt_id';
          const result = await queryDatabase(query, params, env);
          res.json({ deleted: result.length, videos: result });
        }
        break;
      }
      
      case 'delicious-sienna-fluke_db_channelStats':
      case 'prod_db_channelStats': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { channelName } = args;
        
        let query = `
          SELECT 
            uploader as channel_name,
            COUNT(*) as total_videos,
            COUNT(CASE WHEN EXISTS (SELECT 1 FROM process_requests pr WHERE pr.video_id = v.id AND pr.status = 'completed') THEN 1 END) as processed_videos,
            AVG(duration) as avg_duration,
            MIN(inserted_at) as first_video,
            MAX(inserted_at) as latest_video
          FROM videos v
        `;
        
        let params = [];
        if (channelName) {
          query += ' WHERE uploader = $1';
          params.push(channelName);
        }
        
        query += ' GROUP BY uploader ORDER BY total_videos DESC';
        
        const result = await queryDatabase(query, params, env);
        res.json(result);
        break;
      }
      
      case 'delicious-sienna-fluke_db_processingAnalytics':
      case 'prod_db_processingAnalytics': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { days = 7 } = args;
        
        const query = `
          SELECT 
            DATE_TRUNC('day', pr.inserted_at) as date,
            COUNT(*) as total_requests,
            COUNT(CASE WHEN pr.status = 'completed' THEN 1 END) as completed,
            COUNT(CASE WHEN pr.status = 'failed' THEN 1 END) as failed,
            COUNT(CASE WHEN pr.status = 'processing' THEN 1 END) as processing,
            AVG(EXTRACT(EPOCH FROM (pr.updated_at - pr.inserted_at))) as avg_processing_time_seconds
          FROM process_requests pr
          WHERE pr.inserted_at > NOW() - INTERVAL '${days} days'
          GROUP BY DATE_TRUNC('day', pr.inserted_at)
          ORDER BY date DESC
        `;
        
        const result = await queryDatabase(query, [], env);
        res.json(result);
        break;
      }
      
      case 'delicious-sienna-fluke_db_languageAnalytics':
      case 'prod_db_languageAnalytics': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        
        const query = `
          SELECT 
            language,
            COUNT(*) as total_videos,
            COUNT(CASE WHEN EXISTS (SELECT 1 FROM process_requests pr WHERE pr.video_id = v.id AND pr.status = 'completed') THEN 1 END) as processed_videos,
            ROUND(AVG(duration), 2) as avg_duration
          FROM videos v
          WHERE language IS NOT NULL
          GROUP BY language
          ORDER BY total_videos DESC
        `;
        
        const result = await queryDatabase(query, [], env);
        res.json(result);
        break;
      }
      
      case 'delicious-sienna-fluke_db_errorAnalysis':
      case 'prod_db_errorAnalysis': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { days = 30 } = args;
        
        const query = `
          SELECT 
            failure_reason as error_message,
            COUNT(*) as occurrence_count,
            MIN(pr.updated_at) as first_seen,
            MAX(pr.updated_at) as last_seen
          FROM process_requests pr
          WHERE pr.status = 'failed' 
            AND pr.updated_at > NOW() - INTERVAL '${days} days'
            AND failure_reason IS NOT NULL
          GROUP BY failure_reason
          ORDER BY occurrence_count DESC
          LIMIT 50
        `;
        
        const result = await queryDatabase(query, [], env);
        res.json(result);
        break;
      }
      
      case 'delicious-sienna-fluke_db_storageAnalysis':
      case 'prod_db_storageAnalysis': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        
        const query = `
          SELECT 
            COUNT(*) as total_videos,
            COUNT(CASE WHEN audio_url IS NOT NULL THEN 1 END) as videos_with_audio,
            COUNT(CASE WHEN frames_extracted = true THEN 1 END) as videos_with_frames,
            COUNT(CASE WHEN transcript IS NOT NULL THEN 1 END) as videos_with_transcript,
            SUM(duration) as total_duration_seconds,
            AVG(duration) as avg_duration_seconds
          FROM videos v
        `;
        
        const result = await queryDatabase(query, [], env);
        res.json(result[0]);
        break;
      }
      
      case 'delicious-sienna-fluke_db_userActivity':
      case 'prod_db_userActivity': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { days = 30, userId } = args;
        
        let query = `
          SELECT 
            u.id as user_id,
            u.email,
            COUNT(pr.*) as total_requests,
            COUNT(CASE WHEN pr.status = 'completed' THEN 1 END) as completed_requests,
            COUNT(CASE WHEN pr.status = 'failed' THEN 1 END) as failed_requests,
            MIN(pr.inserted_at) as first_request,
            MAX(pr.inserted_at) as last_request
          FROM users u
          LEFT JOIN process_requests pr ON pr.user_id = u.id 
            AND pr.inserted_at > NOW() - INTERVAL '${days} days'
        `;
        
        let params = [];
        if (userId) {
          query += ' WHERE u.id = $1';
          params.push(userId);
        }
        
        query += ' GROUP BY u.id, u.email ORDER BY total_requests DESC';
        
        const result = await queryDatabase(query, params, env);
        res.json(result);
        break;
      }
      
      case 'delicious-sienna-fluke_db_cleanupOrphaned':
      case 'prod_db_cleanupOrphaned': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { dryRun = true } = args;
        
        const query = `
          DELETE FROM process_requests 
          WHERE video_id NOT IN (SELECT id FROM videos)
          ${dryRun ? '' : 'RETURNING id, video_id'}
        `;
        
        if (dryRun) {
          const countQuery = `
            SELECT COUNT(*) as count 
            FROM process_requests 
            WHERE video_id NOT IN (SELECT id FROM videos)
          `;
          const result = await queryDatabase(countQuery, [], env);
          res.json({ dryRun: true, wouldDelete: parseInt(result[0].count) });
        } else {
          const result = await queryDatabase(query, [], env);
          res.json({ deleted: result.length, orphanedRequests: result });
        }
        break;
      }
      
      case 'delicious-sienna-fluke_db_retryAllFailed':
      case 'prod_db_retryAllFailed': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { limit = 10, errorPattern } = args;
        
        let query = `
          UPDATE process_requests 
          SET status = 'pending', updated_at = NOW()
          WHERE status = 'failed'
        `;
        
        let params = [];
        
        if (errorPattern) {
          query += ` AND failure_reason ILIKE $${params.length + 1}`;
          params.push(`%${errorPattern}%`);
        }
        
        // Use subquery for LIMIT with UPDATE
        query = `
          UPDATE process_requests 
          SET status = 'pending', updated_at = NOW()
          WHERE id IN (
            SELECT id FROM process_requests
            WHERE status = 'failed'
            ${errorPattern ? `AND failure_reason ILIKE $1` : ''}
            ORDER BY updated_at DESC
            LIMIT $${params.length + 1}
          )
          RETURNING id, video_id`;
        params.push(limit);
        
        const result = await queryDatabase(query, params, env);
        res.json({ retried: result.length, jobs: result });
        break;
      }
      
      case 'delicious-sienna-fluke_db_listAnonymousUsers':
      case 'prod_db_listAnonymousUsers': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { limit = 100 } = args;
        
        const query = `
          SELECT 
            u.id,
            u.email,
            u.credits,
            COUNT(DISTINCT pr.id) as process_request_count,
            COUNT(DISTINCT pr.video_id) as unique_videos_processed,
            COUNT(CASE WHEN pr.status = 'completed' THEN 1 END) as completed_requests,
            COUNT(CASE WHEN pr.status = 'failed' THEN 1 END) as failed_requests,
            MIN(pr.inserted_at) as first_request,
            MAX(pr.inserted_at) as last_request
          FROM users u
          LEFT JOIN process_requests pr ON pr.user_id = u.id
          WHERE u.email LIKE 'user_%@%'
          GROUP BY u.id, u.email, u.credits
          ORDER BY u.inserted_at DESC
          LIMIT $1
        `;
        
        const users = await queryDatabase(query, [limit], env);
        res.json(users);
        break;
      }
      
      case 'delicious-sienna-fluke_db_deleteAnonymousUsers':
      case 'prod_db_deleteAnonymousUsers': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { userIds, dryRun = true } = args;
        
        if (!userIds || userIds.length === 0) {
          // If no user IDs specified, find all anonymous users
          const findQuery = `
            SELECT id FROM users 
            WHERE email LIKE 'user_%@%'
          `;
          const anonymousUsers = await queryDatabase(findQuery, [], env);
          userIds = anonymousUsers.map(u => u.id);
        }
        
        if (dryRun) {
          // Show what would be deleted
          const infoQuery = `
            SELECT 
              u.id,
              u.email,
              COUNT(DISTINCT pr.id) as process_requests_to_delete,
              COUNT(DISTINCT v.id) as videos_to_delete
            FROM users u
            LEFT JOIN process_requests pr ON pr.user_id = u.id
            LEFT JOIN videos v ON v.id = pr.video_id
            WHERE u.id = ANY($1)
            GROUP BY u.id, u.email
          `;
          const info = await queryDatabase(infoQuery, [userIds], env);
          res.json({ dryRun: true, wouldDelete: info });
        } else {
          // Actually delete - videos will cascade delete process_requests
          const deleteVideosQuery = `
            DELETE FROM videos 
            WHERE id IN (
              SELECT DISTINCT video_id 
              FROM process_requests 
              WHERE user_id = ANY($1)
            )
            RETURNING id, yt_id, title
          `;
          const deletedVideos = await queryDatabase(deleteVideosQuery, [userIds], env);
          
          // Delete users
          const deleteUsersQuery = `
            DELETE FROM users 
            WHERE id = ANY($1)
            RETURNING id, email
          `;
          const deletedUsers = await queryDatabase(deleteUsersQuery, [userIds], env);
          
          res.json({ 
            dryRun: false, 
            deleted: {
              users: deletedUsers,
              videos: deletedVideos
            }
          });
        }
        break;
      }
      
      case 'delicious-sienna-fluke_db_deleteUserById':
      case 'prod_db_deleteUserById': {
        const env = toolName.startsWith('delicious-sienna-fluke_db_') ? 'delicious-sienna-fluke' : 'production';
        const { userId, dryRun = true } = args;
        
        if (!userId) {
          res.status(400).json({ error: 'Missing required parameter: userId' });
          break;
        }
        
        if (dryRun) {
          // Show what would be deleted
          const infoQuery = `
            SELECT 
              u.id,
              u.email,
              u.credits,
              COUNT(DISTINCT pr.id) as process_requests_to_delete,
              COUNT(DISTINCT v.id) as videos_to_delete
            FROM users u
            LEFT JOIN process_requests pr ON pr.user_id = u.id
            LEFT JOIN videos v ON v.id = pr.video_id
            WHERE u.id = $1
            GROUP BY u.id, u.email, u.credits
          `;
          const info = await queryDatabase(infoQuery, [userId], env);
          res.json({ dryRun: true, wouldDelete: info[0] || null });
        } else {
          // Actually delete - videos will cascade delete process_requests
          const deleteVideosQuery = `
            DELETE FROM videos 
            WHERE id IN (
              SELECT DISTINCT video_id 
              FROM process_requests 
              WHERE user_id = $1
            )
            RETURNING id, yt_id, title
          `;
          const deletedVideos = await queryDatabase(deleteVideosQuery, [userId], env);
          
          // Delete user
          const deleteUserQuery = `
            DELETE FROM users 
            WHERE id = $1
            RETURNING id, email, credits
          `;
          const deletedUser = await queryDatabase(deleteUserQuery, [userId], env);
          
          res.json({ 
            dryRun: false, 
            deleted: {
              user: deletedUser[0] || null,
              videos: deletedVideos
            }
          });
        }
        break;
      }
      
      default:
        res.status(404).json({ error: `Unknown tool: ${toolName}` });
    }
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', name: 'delicious-sienna-fluke', version: '1.0.0' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'delicious-sienna-fluke MCP Server',
    endpoints: {
      sse: '/sse',
      api: '/api/mcp/:toolName',
      health: '/health'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`MCP HTTP/SSE server running on http://localhost:${PORT}`);
  console.log(`Configured for delicious-sienna-fluke dataset: ${AXIOM_DELICIOUS_SIENNA_FLUKE_DATASET}`);
  console.log(`Configured for production dataset: ${AXIOM_PRODUCTION_DATASET}`);
});