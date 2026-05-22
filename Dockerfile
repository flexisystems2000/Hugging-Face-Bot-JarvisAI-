FROM node:20-alpine

# Install system dependencies needed for Baileys/media handling
RUN apk add --no-cache \
    git \
    ffmpeg \
    bash

WORKDIR /app

# Copy dependency mappings first to optimize caching
COPY package.json ./

# Force a clean installation of Node 20 packages
RUN npm install --no-audit --no-fund

# Copy the rest of your application code
COPY . .

# Grant wide-open permissions for Baileys authentication session files
RUN chmod -R 777 /app

EXPOSE 7860
ENV PORT=7860
ENV NODE_ENV=production

CMD ["node", "index.js"]
