#!/bin/bash
set -e

TENANT=${1:-tamaprint}

cd "$(dirname "$0")/.."

if [ "$TENANT" = "flexoimpresos" ]; then
  COMPOSE_FILE="docker-compose.flexoimpresos.yml"
  PORT=3001
else
  COMPOSE_FILE="docker-compose.yml"
  PORT=3000
fi

echo "Desplegando OrderLoader [$TENANT] en Docker..."
docker compose -f "$COMPOSE_FILE" up -d --build --remove-orphans

echo ""
echo "Contenedores corriendo:"
docker ps --filter name=orderloader --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo ""
echo "Dashboard: http://localhost:$PORT"
