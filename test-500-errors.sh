#!/bin/bash

echo "Testing endpoints that should return 500 errors..."
BASE_URL="https://axiom-mcp-server.fly.dev/api/mcp"

# Test endpoints without required parameters
echo -e "\n1. logs_search without query (required):"
curl -s -X POST "$BASE_URL/logs_search" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -o /tmp/response.json \
  -w "HTTP %{http_code}\n"
cat /tmp/response.json | jq -r '.error // .' | head -5

echo -e "\n2. logs_timeRange without from/to (required):"
curl -s -X POST "$BASE_URL/logs_timeRange" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -o /tmp/response.json \
  -w "HTTP %{http_code}\n"
cat /tmp/response.json | jq -r '.error // .' | head -5

echo -e "\n3. logs_byRequest without requestId (required):"
curl -s -X POST "$BASE_URL/logs_byRequest" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -o /tmp/response.json \
  -w "HTTP %{http_code}\n"
cat /tmp/response.json | jq -r '.error // .' | head -5

echo -e "\n4. logs_deleteBeforeDate without date (required):"
curl -s -X POST "$BASE_URL/logs_deleteBeforeDate" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -o /tmp/response.json \
  -w "HTTP %{http_code}\n"
cat /tmp/response.json | jq -r '.error // .' | head -5

echo -e "\n5. prod_logs_search without query (required):"
curl -s -X POST "$BASE_URL/prod_logs_search" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -o /tmp/response.json \
  -w "HTTP %{http_code}\n"
cat /tmp/response.json | jq -r '.error // .' | head -5

echo -e "\n6. prod_logs_timeRange without from/to (required):"
curl -s -X POST "$BASE_URL/prod_logs_timeRange" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -o /tmp/response.json \
  -w "HTTP %{http_code}\n"
cat /tmp/response.json | jq -r '.error // .' | head -5

echo -e "\n7. prod_logs_byRequest without requestId (required):"
curl -s -X POST "$BASE_URL/prod_logs_byRequest" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -o /tmp/response.json \
  -w "HTTP %{http_code}\n"
cat /tmp/response.json | jq -r '.error // .' | head -5

echo -e "\n8. prod_logs_deleteBeforeDate without date (required):"
curl -s -X POST "$BASE_URL/prod_logs_deleteBeforeDate" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -o /tmp/response.json \
  -w "HTTP %{http_code}\n"
cat /tmp/response.json | jq -r '.error // .' | head -5