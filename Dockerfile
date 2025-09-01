# Imagen base ligera y estable
FROM node:18-slim

# Variables de entorno estándar
ENV NODE_ENV=production
ENV PORT=8080

# Directorio de trabajo
WORKDIR /usr/src/app

# Instalar dependencias primero (mejor cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar el código
COPY . .

# Exponer puerto
EXPOSE 8080

# Comando de arranque
CMD ["npm", "start"]
