FROM node:20-alpine

# Install system dependencies needed for Baileys/media handling
RUN apk add --no-cache \
    git \
    ffmpeg \
    bash

WORKDIR /app

# Step 1: Copy your package details directly from the subfolder path
COPY Hugging-Face-Bot-JarvisAI--main/package.json ./

# Step 2: Run clean package installation
RUN npm install --no-audit --no-fund

# Step 3: Copy all application files out from the subfolder into the root app space
COPY Hugging-Face-Bot-JarvisAI--main/ .

# Step 4: Grant permission overrides for your Baileys session management data
RUN chmod -R 777 /app

EXPOSE 7860
ENV PORT=7860
ENV NODE_ENV=production

CMD ["node", "index.js"]
