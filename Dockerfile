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
RUN apk add --no-cache libc6-compat

# Copiar carpeta public (Next.js requiere esto)
COPY --from=builder /app/public ./public

# Crear directorio .next
RUN mkdir -p .next .data

# Las apps 'standalone' agrupan los node_modules necesarios.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

# Correr como root para poder escribir en el volumen .data montado desde el host
# server.js es generado por standalone
CMD ["node", "server.js"]
