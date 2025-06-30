# Imagen base de Node.js
FROM node:18

# Crear directorio de trabajo
WORKDIR /usr/src/app

# Copiar archivos e instalar dependencias
COPY package*.json ./
RUN npm install
COPY . .

# Exponer el puerto esperado por Cloud Run
EXPOSE 8080

# Comando para correr la aplicación
CMD [ "npm", "start" ]
