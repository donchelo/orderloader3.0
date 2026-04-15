#!/bin/bash
set -e

PROJECT_ID="gen-lang-client-0666118566"
ZONE="us-central1-a"
INSTANCE_NAME="orderloader"
VM_USER="ia_tamaprint"
REMOTE_PATH="~/orderLoader"
ARCHIVE_NAME="project_update.tar.gz"

echo "🚀 Iniciando despliegue hacia Google Cloud VM..."

# 1. Comprimir fuentes (excluir artefactos pesados)
echo "📦 Comprimiendo archivos..."
tar --exclude=node_modules \
    --exclude=.next \
    --exclude=.git \
    --exclude=.data \
    --exclude="$ARCHIVE_NAME" \
    -czf "$ARCHIVE_NAME" .

# 2. Subir a la VM
echo "📤 Subiendo a la VM ($INSTANCE_NAME)..."
gcloud compute scp --project "$PROJECT_ID" --zone "$ZONE" \
    "$ARCHIVE_NAME" "$VM_USER@$INSTANCE_NAME:~/"

# 3. Ejecutar en la VM
echo "⚙️  Construyendo y reiniciando en la VM..."
gcloud compute ssh "$VM_USER@$INSTANCE_NAME" --zone "$ZONE" --command "
  set -e
  mkdir -p $REMOTE_PATH
  tar -xzf ~/$ARCHIVE_NAME -C $REMOTE_PATH
  rm ~/$ARCHIVE_NAME
  cd $REMOTE_PATH

  echo '🐳 Construyendo imagen Docker...'
  sudo docker build -t orderloader_orderloader:latest .

  echo '♻️  Reemplazando contenedor...'
  sudo docker rm -f orderloader 2>/dev/null || true
  sudo docker run -d \
    --name orderloader \
    --restart unless-stopped \
    -p 3000:3000 \
    -e DATA_DIR=/app/.data \
    --env-file .env \
    -v /home/ia_tamaprint/orderLoader/.data:/app/.data \
    orderloader_orderloader:latest

  echo '🧹 Limpiando imágenes viejas...'
  sudo docker image prune -f

  echo '✅ Contenedor corriendo:'
  sudo docker ps --filter name=orderloader --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
"

# 4. Limpieza local
rm -f "$ARCHIVE_NAME"

echo ""
echo "✅ Despliegue completado. App en http://34.59.114.103:3000"
