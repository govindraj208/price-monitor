# Base image with Node and Playwright system dependencies
FROM mcr.microsoft.com/playwright:v1.53.0-noble

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY web/backend/package*.json ./web/backend/

# Install dependencies and exact chromium binary
RUN npm install
RUN cd web/backend && npm install
RUN npx playwright install chromium

# Copy source code
COPY . .

# Set environment
ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

# Start the API server
CMD ["node", "web/backend/src/server.js"]
