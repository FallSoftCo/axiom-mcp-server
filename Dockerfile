FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY . .

# Expose the port
EXPOSE 3456

# Start the HTTP server
CMD ["node", "axiom-mcp-http-server.js"]