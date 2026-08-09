# Use a compact Node image; apparently shipping a whole operating system for one service is optional.
FROM node:20-bookworm-slim

# Tell Node dependencies to use their production behavior inside the container.
ENV NODE_ENV=production

# Keep the application and all following commands in one predictable directory.
WORKDIR /application

# Copy dependency manifests first so Docker can reuse this install layer when only source code changes.
COPY package.json package-lock.json ./
# Install the exact locked dependency versions, because surprises belong in the application, not the build.
RUN npm ci
# Add the TypeScript source after dependencies are safely cached.
COPY src ./src

# The fraud API listens on 9000 and its model service listens on 9001.
EXPOSE 9000 9001