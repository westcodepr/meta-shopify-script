# Imagen base ligera
FROM node:18-slim

# Asegura zona y entorno prod
ENV NODE_ENV=production
ENV PORT=8080

# Directorio de trabajo
WORKDIR /usr/src/app

# Instala deps primero (mejor cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia código
COPY . .

# Expone puerto
EXPOSE 8080

# Levanta la app
CMD ["npm", "start"]
