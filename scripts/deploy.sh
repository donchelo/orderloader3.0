#!/bin/bash
set -e

echo "🚀 Desplegando OrderLoader en Docker local..."

cd "$(dirname "$0")/.."

echo "🐳 Construyendo imagen y reiniciando contenedor..."
docker compose up -d --build

echo ""
echo "✅ Contenedor corriendo:"
docker ps --filter name=orderloader --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo ""
echo "📊 Dashboard: http://localhost:3000"
