#!/bin/bash
set -e

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE="user@your-server"
REMOTE_DIR="/home/ecauth"
SSH_KEY="REDACTED"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no"

echo "=== Building ==="
cd "$LOCAL_DIR"
npm run build

echo "=== Syncing dist ==="
rsync -azP -e "ssh $SSH_OPTS" "$LOCAL_DIR/dist/" "$REMOTE:$REMOTE_DIR/dist/"

echo "=== Syncing public ==="
rsync -azP -e "ssh $SSH_OPTS" "$LOCAL_DIR/public/" "$REMOTE:$REMOTE_DIR/public/"

echo "=== Syncing db ==="
rsync -azP -e "ssh $SSH_OPTS" "$LOCAL_DIR/db/" "$REMOTE:$REMOTE_DIR/db/"

echo "=== Syncing .env ==="
rsync -azP -e "ssh $SSH_OPTS" "$LOCAL_DIR/.env" "$REMOTE:$REMOTE_DIR/.env"

echo "=== Starting/Restarting service ==="
ssh $SSH_OPTS $REMOTE "
  cd $REMOTE_DIR

  if ! pm2 describe ecauth > /dev/null 2>&1; then
    pm2 start dist/server.js --name ecauth
  else
    pm2 restart ecauth
  fi
  pm2 save

  sleep 2
  curl -sf http://127.0.0.1:3008/ecauth/health && echo ' - Health check OK' || echo ' - Health check FAILED'
"

echo "=== Deploy complete ==="
