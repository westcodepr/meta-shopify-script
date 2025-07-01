# Imagen base de Node.js
FROM node:18

# Crear directorio de trabajo
WORKDIR /usr/src/app

# Copiar archivos
COPY package*.json ./
RUN npm install
COPY . .

# Exponer puerto 8080 y ejecutar app
EXPOSE 8080
CMD ["npm", "index.js"]
