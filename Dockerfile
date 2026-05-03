# Dockerfile
# Stage 1: Dependencias y compilar la aplicación
FROM node:20-alpine AS builder

# better-sqlite3 requiere python, make y g++ para compilar nativamente
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Copiar archivos de dependencias
COPY package.json package-lock.json* ./

# Instalar dependencias puras (incluyendo devDependencies para el build)
RUN npm ci

# Copiar resto del código fuente del proyecto
COPY . .

# Deshabilitar telemetría de Next.js durante build
ENV NEXT_TELEMETRY_DISABLED=1

# Compilar Next.js (esto generará .next/standalone si lo configuramos en next.config.ts)
RUN npm run build

# Stage 2: Imagen de producción mínima
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Usaremos NEXT_STANDALONE para iniciar usando el servidor nativo
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Instalar posibles dependencias de runtime nativas requeridas
# poppler-utils: pdftoppm convierte páginas PDF a PNG para análisis visual con Claude
# font-liberation + ttf-dejavu: fuentes Helvetica-compatibles requeridas para renderizar PDFs
RUN apk add --no-cache libc6-compat poppler-utils font-liberation ttf-dejavu fontconfig \
    && fc-cache -f

# Copiar carpeta public (Next.js requiere esto)
COPY --from=builder /app/public ./public

# Crear directorios y transferir ownership al usuario node (UID 1000)
RUN mkdir -p .next .data && chown -R node:node /app

# Las apps 'standalone' agrupan los node_modules necesarios.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node

EXPOSE 3000

CMD ["node", "server.js"]
