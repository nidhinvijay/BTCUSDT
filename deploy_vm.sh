#!/bin/bash

# Exit on error
set -e

echo "Starting setup..."

# 1. Install Node.js 20
echo "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Install PM2
echo "Installing PM2..."
sudo npm install -g pm2

# 3. Setup Firewall (allow port 3000)
echo "Configuring firewall..."
# Note: This only opens the local firewall. GCP Firewall rules must also be set.
sudo ufw allow 3000/tcp || echo "UFW not active, skipping..."

echo "------------------------------------------------"
echo "Setup Complete!"
echo "------------------------------------------------"
echo "To start your app:"
echo "1. Copy your project files here (git clone or scp)"
echo "2. cd into the directory"
echo "3. Run: npm install"
echo "4. Run: pm2 start src/index.js --name trader"
echo "5. Check logs: pm2 logs"
echo "------------------------------------------------"
