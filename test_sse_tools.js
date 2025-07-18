import { EventSource } from 'eventsource';
import fetch from 'node-fetch';

async function testSSEConnection() {
  console.log('Connecting to SSE endpoint...');
  
  const eventSource = new EventSource('https://axiom-mcp-server.fly.dev/sse');
  
  eventSource.onopen = () => {
    console.log('SSE connection opened');
  };
  
  eventSource.addEventListener('endpoint', async (event) => {
    const endpoint = event.data;
    console.log('Received endpoint:', endpoint);
    
    // Extract sessionId
    const match = endpoint.match(/sessionId=([^&]+)/);
    if (match) {
      const sessionId = match[1];
      console.log('Session ID:', sessionId);
      
      // Send tools/list request
      const response = await fetch(`https://axiom-mcp-server.fly.dev/message?sessionId=${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
          id: 1
        })
      });
      
      const result = await response.text();
      console.log('POST response:', result);
    }
  });
  
  eventSource.addEventListener('message', (event) => {
    console.log('Received message:', event.data);
    try {
      const data = JSON.parse(event.data);
      if (data.result && data.result.tools) {
        console.log('\nTools found:', data.result.tools.length);
        data.result.tools.forEach((tool, index) => {
          console.log(`${index + 1}. ${tool.name}: ${tool.description}`);
        });
        eventSource.close();
        process.exit(0);
      }
    } catch (e) {
      // Not JSON, ignore
    }
  });
  
  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
    eventSource.close();
    process.exit(1);
  };
  
  // Timeout after 30 seconds
  setTimeout(() => {
    console.log('Timeout reached, closing connection');
    eventSource.close();
    process.exit(1);
  }, 30000);
}

testSSEConnection();