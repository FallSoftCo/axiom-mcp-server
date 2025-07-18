#\!/bin/bash

echo "Testing all deployed API endpoints..."

# Test 1: Recent logs
echo -e "\n1. logs_recent:"
curl -s -X POST "https://axiom-mcp-server.fly.dev/api/mcp/logs_recent" \
  -H "Content-Type: application/json" \
  -d '{"limit": 2}' | jq '. | length'

# Test 2: Search
echo -e "\n2. logs_search:"
curl -s -X POST "https://axiom-mcp-server.fly.dev/api/mcp/logs_search" \
  -H "Content-Type: application/json" \
  -d '{"query": "test", "limit": 2}' | jq '. | length'

# Test 3: Errors
echo -e "\n3. logs_errors:"
curl -s -X POST "https://axiom-mcp-server.fly.dev/api/mcp/logs_errors" \
  -H "Content-Type: application/json" \
  -d '{"limit": 2}' | jq

# Test 4: Stats
echo -e "\n4. logs_stats:"
curl -s -X POST "https://axiom-mcp-server.fly.dev/api/mcp/logs_stats" \
  -H "Content-Type: application/json" \
  -d '{"hours": 1}' | jq '. | type'

echo -e "\nAll API tests completed\!"
