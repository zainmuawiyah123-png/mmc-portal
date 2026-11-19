#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/server"

if [ ! -d node_modules ]; then
  echo "Installing dependencies for this computer..."
  npm install
else
  echo "Rebuilding native SQLite module for this computer..."
  npm rebuild better-sqlite3
fi

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i 's/^JWT_SECRET=.*/JWT_SECRET=mmc-local-development-secret-change-me/' .env
  echo "Created server/.env"
fi

npm run migrate
printf '\nMMC server is starting at: http://localhost:4000\n'
printf 'Open the procurement portal at: http://localhost:4000/procurement/index.html\n'
printf 'Press Ctrl+C to stop the server.\n\n'
npm start
