#!/bin/bash

# 启动服务器（假设已经构建）
echo "Testing 'all' and 'default' time ranges..."

# 测试 "all" 时间范围
echo ""
echo "Testing window=all:"
curl -s "http://localhost:8080/api/admin/logs/top?window=all&limit=5" | head -20

# 测试 "default" 时间范围
echo ""
echo "Testing window=default:"
curl -s "http://localhost:8080/api/admin/logs/top?window=default&limit=5" | head -20

echo ""
echo "Tests completed."
