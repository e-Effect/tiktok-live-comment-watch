FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-package-lock

COPY . .

ENV NODE_ENV=production
EXPOSE 3030

CMD ["npm", "start"]
