#!/bin/bash
# Test script for time range filtering feature

echo "Testing Time Range Filter API..."
echo ""

BASE_URL="http://localhost:3000"

# Test 1: Default range (should return all windows)
echo "Test 1: Default range"
curl -s "${BASE_URL}/api/admin/logs/token-usage?range=default" | jq '.today, .one_day, .seven_days, .thirty_days, .all_time | {total_tokens, request_count}'
echo ""

# Test 2: All time range
echo "Test 2: All time range"
curl -s "${BASE_URL}/api/admin/logs/token-usage?range=all" | jq '.today | {total_tokens, request_count}'
echo ""

# Test 3: Custom range (last 7 days)
START_DATE=$(date -d "7 days ago" +%Y-%m-%d)
END_DATE=$(date +%Y-%m-%d)
echo "Test 3: Custom range ($START_DATE to $END_DATE)"
curl -s "${BASE_URL}/api/admin/logs/token-usage?range=custom&start_date=${START_DATE}&end_date=${END_DATE}" | jq '.today | {total_tokens, request_count}'
echo ""

# Test 4: Invalid custom range (missing dates)
echo "Test 4: Invalid custom range (should return error)"
curl -s "${BASE_URL}/api/admin/logs/token-usage?range=custom" | jq '.'
echo ""

echo "All tests completed!"
