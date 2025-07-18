#!/bin/bash

echo "Testing all API endpoints for 500 errors..."

BASE_URL="https://axiom-mcp-server.fly.dev/api/mcp"

# Test staging endpoints
echo -e "\n=== STAGING ENDPOINTS ==="

echo -e "\n1. logs_recent:"
curl -s -X POST "$BASE_URL/logs_recent" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n2. logs_search (with query):"
curl -s -X POST "$BASE_URL/logs_search" \
  -H "Content-Type: application/json" \
  -d '{"query": "error", "limit": 1}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n3. logs_search (without query - should fail):"
curl -s -X POST "$BASE_URL/logs_search" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n4. logs_errors:"
curl -s -X POST "$BASE_URL/logs_errors" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n5. logs_timeRange (with params):"
curl -s -X POST "$BASE_URL/logs_timeRange" \
  -H "Content-Type: application/json" \
  -d '{"from": "2025-06-30T00:00:00Z", "to": "2025-06-30T23:59:59Z"}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n6. logs_timeRange (without params - should fail):"
curl -s -X POST "$BASE_URL/logs_timeRange" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n7. logs_byRequest (with requestId):"
curl -s -X POST "$BASE_URL/logs_byRequest" \
  -H "Content-Type: application/json" \
  -d '{"requestId": "test-123"}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n8. logs_byRequest (without requestId - should fail):"
curl -s -X POST "$BASE_URL/logs_byRequest" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n9. logs_stats:"
curl -s -X POST "$BASE_URL/logs_stats" \
  -H "Content-Type: application/json" \
  -d '{"hours": 1}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n10. logs_deleteBeforeDate (with date):"
curl -s -X POST "$BASE_URL/logs_deleteBeforeDate" \
  -H "Content-Type: application/json" \
  -d '{"date": "2020-01-01T00:00:00Z"}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n11. logs_deleteBeforeDate (without date - should fail):"
curl -s -X POST "$BASE_URL/logs_deleteBeforeDate" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n12. logs_getDatasetInfo:"
curl -s -X POST "$BASE_URL/logs_getDatasetInfo" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n13. logs_clearAll:"
curl -s -X POST "$BASE_URL/logs_clearAll" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w " -> HTTP %{http_code}\n"

# Test production endpoints
echo -e "\n=== PRODUCTION ENDPOINTS ==="

echo -e "\n14. prod_logs_recent:"
curl -s -X POST "$BASE_URL/prod_logs_recent" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n15. prod_logs_errors:"
curl -s -X POST "$BASE_URL/prod_logs_errors" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\n16. prod_logs_getDatasetInfo:"
curl -s -X POST "$BASE_URL/prod_logs_getDatasetInfo" \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w " -> HTTP %{http_code}\n"

echo -e "\nTest complete!"