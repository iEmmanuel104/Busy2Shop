# Use an official Node.js runtime as a parent image
FROM node:18-alpine AS builder

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install all dependencies (including devDependencies)
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the TypeScript code
RUN npm run build

# Make sure the docs directory exists in dist
RUN mkdir -p dist/docs

# Copy YAML files to dist/docs
RUN if [ -d "src/docs" ]; then cp -r src/docs/*.yaml dist/docs/; fi

# Start a new stage for a smaller production image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy the built application from the previous stage
COPY --from=builder /usr/src/app/dist ./dist

# Copy src/docs directory to dist/docs for Swagger documentation
COPY --from=builder /usr/src/app/src/docs ./dist/docs

# Expose the port the app runs on
EXPOSE 8080

# Run the app with npm run prod
CMD ["npm", "run", "prod"]