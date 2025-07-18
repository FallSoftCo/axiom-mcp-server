#!/usr/bin/env python3
import json
import requests
import sseclient
import threading
import time

def test_mcp_tools():
    # First establish SSE connection
    print("Connecting to SSE endpoint...")
    sse_response = requests.get('https://axiom-mcp-server.fly.dev/sse', stream=True)
    client = sseclient.SSEClient(sse_response)
    
    session_id = None
    
    # Get session ID from first event
    for event in client.events():
        if event.event == 'endpoint':
            endpoint = event.data
            print(f"Received endpoint: {endpoint}")
            # Extract sessionId
            if 'sessionId=' in endpoint:
                session_id = endpoint.split('sessionId=')[1].split('&')[0]
                print(f"Session ID: {session_id}")
                break
    
    if not session_id:
        print("Failed to get session ID")
        return
    
    # Send tools/list request in a separate thread
    def send_request():
        time.sleep(0.5)  # Small delay to ensure listener is ready
        payload = {
            "jsonrpc": "2.0",
            "method": "tools/list",
            "params": {},
            "id": 1
        }
        url = f"https://axiom-mcp-server.fly.dev/message?sessionId={session_id}"
        print(f"\nSending tools/list request to {url}")
        print(f"Payload: {json.dumps(payload, indent=2)}")
        
        response = requests.post(url, json=payload)
        print(f"POST response: {response.text}")
    
    # Start request thread
    request_thread = threading.Thread(target=send_request)
    request_thread.start()
    
    # Continue listening for response
    print("\nListening for response...")
    timeout = time.time() + 30  # 30 second timeout
    
    for event in client.events():
        if time.time() > timeout:
            print("Timeout reached")
            break
            
        if event.event == 'message' or event.data:
            print(f"\nReceived event: {event.event}")
            print(f"Data: {event.data[:200]}...")  # Show first 200 chars
            
            try:
                data = json.loads(event.data)
                if 'result' in data and 'tools' in data.get('result', {}):
                    tools = data['result']['tools']
                    print(f"\n✓ Found {len(tools)} tools:")
                    for i, tool in enumerate(tools, 1):
                        print(f"{i}. {tool['name']}: {tool.get('description', 'No description')[:60]}...")
                    
                    # Check for our missing tools
                    tool_names = [t['name'] for t in tools]
                    missing = ['logs_deleteBeforeDate', 'logs_getDatasetInfo', 'logs_clearAll']
                    found_missing = [t for t in missing if t in tool_names]
                    not_found = [t for t in missing if t not in tool_names]
                    
                    print(f"\nMissing tools found: {found_missing}")
                    print(f"Missing tools not found: {not_found}")
                    
                    return
            except json.JSONDecodeError:
                pass
    
    request_thread.join()
    print("\nNo tools list received")

if __name__ == "__main__":
    test_mcp_tools()