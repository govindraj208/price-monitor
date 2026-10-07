# Official Playwright container with all browser dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY web/backend/package*.json ./web/backend/

# Install dependencies
RUN npm install
RUN cd web/backend && npm install

# Copy source code
COPY . .

# Set environment
ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

# Start the API server
CMD ["node", "web/backend/src/server.js"]
