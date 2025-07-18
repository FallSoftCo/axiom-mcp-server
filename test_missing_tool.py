import json
import requests

# Test if we can call logs_deleteBeforeDate directly
payload = {
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
        "name": "logs_deleteBeforeDate",
        "arguments": {
            "beforeDate": "2025-06-18T00:00:00Z"
        }
    },
    "id": 2
}

print("Testing if logs_deleteBeforeDate tool exists...")
print(f"Payload: {json.dumps(payload, indent=2)}")

# Note: This would need proper SSE handling in production
# For now just showing the request structure
