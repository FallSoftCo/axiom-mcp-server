#\!/bin/bash

AXIOM_API_TOKEN="xaat-b7d32f2d-76e5-4c44-be33-c702fa2a74a6"
API_URL="https://api.axiom.co/v1/datasets/_apl?format=legacy"

echo "Testing all Axiom APL queries..."

# Test 1: Recent logs
echo -e "\n1. Testing recent logs query:"
curl -s -X POST "$API_URL" \
  -H "Authorization: Bearer $AXIOM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"apl": "['\''delicious-sienna-fluke'\''] | sort by _time desc | limit 2"}' | \
  jq '.matches | length'

# Test 2: Search query
echo -e "\n2. Testing search query:"
curl -s -X POST "$API_URL" \
  -H "Authorization: Bearer $AXIOM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"apl": "['\''delicious-sienna-fluke'\''] | where message contains \"test\" | sort by _time desc | limit 2"}' | \
  jq '.matches | length'

# Test 3: Error logs
echo -e "\n3. Testing error logs query:"
curl -s -X POST "$API_URL" \
  -H "Authorization: Bearer $AXIOM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"apl": "['\''delicious-sienna-fluke'\''] | where level == \"error\" | sort by _time desc | limit 2"}' | \
  jq '.matches | length'

# Test 4: Stats query
echo -e "\n4. Testing stats query:"
curl -s -X POST "$API_URL" \
  -H "Authorization: Bearer $AXIOM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"apl": "['\''delicious-sienna-fluke'\''] | summarize count() by bin(_time, 1h), level | sort by _time desc"}' | \
  jq '.status'

echo -e "\nAll tests completed\!"
