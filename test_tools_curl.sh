#!/bin/bash

# Function to parse SSE data
parse_sse_data() {
    while IFS= read -r line; do
        if [[ $line == data:* ]]; then
            echo "${line#data: }"
        fi
    done
}

echo "Testing MCP tools list via SSE..."

# Create a named pipe for communication
PIPE=$(mktemp -u)
mkfifo "$PIPE"

# Start SSE listener in background
(
    curl -s -N "https://axiom-mcp-server.fly.dev/sse" | while IFS= read -r line; do
        echo "$line" >> "$PIPE"
    done
) &
SSE_PID=$!

# Read the initial endpoint message
SESSION_ID=""
while IFS= read -r line; do
    if [[ $line == *"data: /message?sessionId="* ]]; then
        SESSION_ID=$(echo "$line" | grep -oP 'sessionId=\K[^&]+')
        echo "Got session ID: $SESSION_ID"
        break
    fi
done < "$PIPE" &
READ_PID=$!

# Wait a bit for session ID
sleep 2
kill $READ_PID 2>/dev/null || true

if [ -z "$SESSION_ID" ]; then
    echo "Failed to get session ID"
    kill $SSE_PID 2>/dev/null || true
    rm -f "$PIPE"
    exit 1
fi

# Send the tools/list request
echo "Sending tools/list request..."
curl -s -X POST "https://axiom-mcp-server.fly.dev/message?sessionId=$SESSION_ID" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' &

# Read the response
echo "Waiting for response..."
(
    timeout 10 cat "$PIPE" | while IFS= read -r line; do
        if [[ $line == data:* ]]; then
            DATA="${line#data: }"
            # Try to parse as JSON
            if echo "$DATA" | jq -e '.result.tools' >/dev/null 2>&1; then
                echo -e "\n✓ Found tools response:"
                echo "$DATA" | jq '.result.tools | length' | xargs -I {} echo "Total tools: {}"
                echo -e "\nTools list:"
                echo "$DATA" | jq -r '.result.tools[] | "\(.name): \(.description[:60])..."'
                
                # Check for missing tools
                echo -e "\nChecking for missing tools..."
                for tool in "logs_deleteBeforeDate" "logs_getDatasetInfo" "logs_clearAll"; do
                    if echo "$DATA" | jq -e ".result.tools[] | select(.name == \"$tool\")" >/dev/null 2>&1; then
                        echo "✓ Found: $tool"
                    else
                        echo "✗ Missing: $tool"
                    fi
                done
                
                # Clean up
                kill $SSE_PID 2>/dev/null || true
                rm -f "$PIPE"
                exit 0
            fi
        fi
    done
)

# Clean up
kill $SSE_PID 2>/dev/null || true
rm -f "$PIPE"