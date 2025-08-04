#!/bin/bash

APP_DIR="/home/pi/pi-script-dashboard"
SERVICE_NAME="script-dashboard.service"

# prevent simultaneous updates
touch /tmp/dashboard-update.lock

echo "➡️ Updating Script Dashboard..."

# Step 1: Pull latest changes
echo "📥 Pulling latest changes from Git..."
cd "$APP_DIR" || { echo "❌ Failed to cd into $APP_DIR"; exit 1; }
git pull

# Step 2: Install Node dependencies
echo "📦 Installing dependencies..."
npm install --production

# Step 3: Build Tailwind CSS
echo "🎨 Building Tailwind CSS..."
npm run build:css

# Step 4: Restart the systemd service
echo "🔄 Restarting $SERVICE_NAME..."
sudo systemctl restart "$SERVICE_NAME"

# Step 5: Check status
sleep 1
sudo systemctl status "$SERVICE_NAME" --no-pager

echo "✅ Script Dashboard update complete."
