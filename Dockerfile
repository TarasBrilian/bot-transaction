FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN chmod +x start.sh
CMD ["sh", "start.sh"]