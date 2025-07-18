// Database tools extension for axiom-mcp-server
// Add this to your axiom-mcp-http-server.js after configuring credentials

// Database configuration (UPDATE THESE WITH YOUR CREDENTIALS)
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'tlyt_phoenix_dev',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '', // Set this!
};

// Add these database tools to your createToolsForDataset function:
const databaseTools = [
  {
    name: 'db_videoStats',
    description: 'Get video database statistics',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'db_processingStatus',
    description: 'Get video processing status summary',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'db_recentVideos',
    description: 'Get recently added videos',
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
    name: 'db_videoByYtId',
    description: 'Get video details by YouTube ID',
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
    name: 'db_userStats',
    description: 'Get user statistics and credit usage',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'db_failedJobs',
    description: 'Get failed processing jobs',
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
    name: 'db_retryJob',
    description: 'Retry a failed processing job',
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
    name: 'db_updateVideoStatus',
    description: 'Update video processing status',
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
  }
];

// Database query functions (using pg library)
async function queryDatabase(query, params = []) {
  const { Pool } = await import('pg');
  const pool = new Pool(DB_CONFIG);
  
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

// Add these handlers to your switch statement in the tool handler:
const dbHandlers = {
  'db_videoStats': async () => {
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
    return await queryDatabase(query);
  },

  'db_processingStatus': async () => {
    const query = `
      SELECT 
        status,
        COUNT(*) as count
      FROM process_requests
      GROUP BY status
      ORDER BY count DESC
    `;
    return await queryDatabase(query);
  },

  'db_recentVideos': async (args) => {
    const { limit = 10 } = args;
    const query = `
      SELECT 
        id, yt_id, title, channel_name, duration, 
        language, current_version, inserted_at
      FROM videos
      ORDER BY inserted_at DESC
      LIMIT $1
    `;
    return await queryDatabase(query, [limit]);
  },

  'db_videoByYtId': async (args) => {
    const { ytId } = args;
    if (!ytId) throw new Error('Missing required parameter: ytId');
    
    const query = `
      SELECT 
        v.*,
        pr.status as processing_status,
        pr.last_error,
        pr.updated_at as last_processed
      FROM videos v
      LEFT JOIN process_requests pr ON pr.video_id = v.id
      WHERE v.yt_id = $1
      ORDER BY pr.updated_at DESC
      LIMIT 1
    `;
    return await queryDatabase(query, [ytId]);
  },

  'db_userStats': async () => {
    const query = `
      SELECT 
        COUNT(DISTINCT u.id) as total_users,
        COUNT(DISTINCT CASE WHEN u.credits > 0 THEN u.id END) as users_with_credits,
        COUNT(DISTINCT pr.user_id) as active_users,
        SUM(u.credits) as total_credits_remaining,
        AVG(u.processed_videos)::INTEGER as avg_videos_per_user
      FROM users u
      LEFT JOIN process_requests pr ON pr.user_id = u.id
    `;
    return await queryDatabase(query);
  },

  'db_failedJobs': async (args) => {
    const { limit = 10 } = args;
    const query = `
      SELECT 
        pr.id,
        pr.video_id,
        v.yt_id,
        v.title,
        pr.operation,
        pr.last_error,
        pr.retry_count,
        pr.updated_at
      FROM process_requests pr
      JOIN videos v ON v.id = pr.video_id
      WHERE pr.status = 'failed'
      ORDER BY pr.updated_at DESC
      LIMIT $1
    `;
    return await queryDatabase(query, [limit]);
  },

  'db_retryJob': async (args) => {
    const { jobId } = args;
    if (!jobId) throw new Error('Missing required parameter: jobId');
    
    const query = `
      UPDATE process_requests
      SET 
        status = 'pending',
        retry_count = retry_count + 1,
        last_error = NULL,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    return await queryDatabase(query, [jobId]);
  },

  'db_updateVideoStatus': async (args) => {
    const { videoId, status } = args;
    if (!videoId || !status) {
      throw new Error('Missing required parameters: videoId and status');
    }
    
    const query = `
      UPDATE videos
      SET 
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, yt_id, title, updated_at
    `;
    const video = await queryDatabase(query, [videoId]);
    
    // Also update process request if exists
    const prQuery = `
      UPDATE process_requests
      SET 
        status = $2,
        updated_at = NOW()
      WHERE video_id = $1
      RETURNING *
    `;
    const pr = await queryDatabase(prQuery, [videoId, status]);
    
    return { video: video[0], processRequest: pr[0] };
  }
};

// Export for use in main server file
module.exports = { databaseTools, dbHandlers };