#!/usr/bin/env python3
import json
import requests
import time
import threading

def test_missing_tool(tool_name, args):
    """Test if a tool can be called even if not listed"""
    
    print(f"\nTesting tool: {tool_name}")
    print(f"Arguments: {json.dumps(args, indent=2)}")
    
    # Get session ID
    sse_response = requests.get('https://axiom-mcp-server.fly.dev/sse', stream=True)
    session_id = None
    
    for line in sse_response.iter_lines():
        if line:
            line_str = line.decode('utf-8')
            if 'data: /message?sessionId=' in line_str:
                session_id = line_str.split('sessionId=')[1].split('&')[0]
                print(f"Session ID: {session_id}")
                break
    
    if not session_id:
        print("Failed to get session ID")
        return
    
    # Prepare to capture response
    response_data = []
    stop_listening = threading.Event()
    
    def listen_for_response():
        """Listen for SSE responses"""
        try:
            for line in sse_response.iter_lines():
                if stop_listening.is_set():
                    break
                if line:
                    line_str = line.decode('utf-8')
                    if line_str.startswith('data: ') and line_str != 'data: ':
                        data = line_str[6:]  # Remove 'data: ' prefix
                        response_data.append(data)
                        try:
                            parsed = json.loads(data)
                            if 'error' in parsed or 'result' in parsed:
                                stop_listening.set()
                        except:
                            pass
        except Exception as e:
            print(f"Listener error: {e}")
    
    # Start listener thread
    listener = threading.Thread(target=listen_for_response)
    listener.start()
    
    # Give listener time to start
    time.sleep(0.5)
    
    # Send tool call request
    payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": args
        },
        "id": 1
    }
    
    url = f"https://axiom-mcp-server.fly.dev/message?sessionId={session_id}"
    print(f"\nSending request to: {url}")
    
    try:
        response = requests.post(url, json=payload)
        print(f"POST response: {response.status_code} - {response.text}")
    except Exception as e:
        print(f"Request error: {e}")
    
    # Wait for response
    time.sleep(3)
    stop_listening.set()
    listener.join(timeout=2)
    
    # Process responses
    print(f"\nReceived {len(response_data)} SSE responses")
    for i, data in enumerate(response_data):
        print(f"\nResponse {i+1}:")
        try:
            parsed = json.loads(data)
            print(json.dumps(parsed, indent=2))
            
            if 'error' in parsed:
                print(f"❌ Error: {parsed['error'].get('message', 'Unknown error')}")
            elif 'result' in parsed:
                print(f"✅ Success! Tool appears to be working")
                print(f"Result: {json.dumps(parsed['result'], indent=2)[:200]}...")
        except:
            print(f"Raw data: {data[:100]}...")

# Test the three missing tools
missing_tools = [
    ("logs_deleteBeforeDate", {"beforeDate": "2025-06-18T00:00:00Z"}),
    ("logs_getDatasetInfo", {}),
    ("logs_clearAll", {})
]

print("Testing potentially missing MCP tools...")
print("=" * 50)

for tool_name, args in missing_tools:
    test_missing_tool(tool_name, args)
    print("\n" + "=" * 50)
    time.sleep(2)  # Delay between tests

print("\nTest complete!")