#!/bin/bash

echo "🔧 Setting up automated cleanup for file upload system"
echo "======================================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Configuration
BACKEND_DIR="/DATA/files_backend"
CLEANUP_SCRIPT="$BACKEND_DIR/cleanup.js"
CRON_SCHEDULE="0 */6 * * *"  # Every 6 hours
LOG_FILE="/DATA/AppData/cleanup.log"

# Check if cleanup.js exists
if [ ! -f "$CLEANUP_SCRIPT" ]; then
    echo -e "${RED}❌ Error: cleanup.js not found at $CLEANUP_SCRIPT${NC}"
    echo "   Please make sure cleanup.js is in $BACKEND_DIR"
    exit 1
fi

echo -e "${GREEN}✅ Found cleanup.js${NC}"
echo ""

# Make cleanup.js executable (just in case)
chmod +x "$CLEANUP_SCRIPT" 2>/dev/null

# Check if Node.js is available
NODE_PATH=$(command -v node)
if [ -z "$NODE_PATH" ]; then
    # Zkusí najít node v běžných cestách nvm, pokud command -v selhal
    NODE_PATH=$(which node)
fi

if [ -z "$NODE_PATH" ]; then
    echo -e "${RED}❌ Error: Node.js not found${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Node.js found at: $NODE_PATH${NC}"
echo -e "${GREEN}✅ Version: $($NODE_PATH --version)${NC}"

echo -e "${GREEN}✅ Node.js found: $(node --version)${NC}"
echo ""

# Test cleanup script
echo "🧪 Testing cleanup script..."
if node "$CLEANUP_SCRIPT"; then
    echo -e "${GREEN}✅ Cleanup script works!${NC}"
else
    echo -e "${RED}❌ Cleanup script failed to run${NC}"
    exit 1
fi

echo ""
echo "📅 Setting up cron job..."

# Create cron job entry
CRON_COMMAND="cd $BACKEND_DIR && node cleanup.js >> $LOG_FILE 2>&1"
CRON_ENTRY="$CRON_SCHEDULE $CRON_COMMAND"

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -F "cleanup.js" > /dev/null; then
    echo -e "${YELLOW}⚠️  Cron job already exists. Updating...${NC}"
    
    # Remove old entry
    crontab -l 2>/dev/null | grep -v "cleanup.js" | crontab -
fi

# Add new cron job
(crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -

echo -e "${GREEN}✅ Cron job added!${NC}"
echo "   Schedule: Every 6 hours"
echo "   Command: $CRON_COMMAND"
echo ""

# Verify cron job was added
if crontab -l 2>/dev/null | grep -F "cleanup.js" > /dev/null; then
    echo -e "${GREEN}✅ Cron job verified in crontab${NC}"
else
    echo -e "${RED}❌ Failed to add cron job${NC}"
    exit 1
fi

echo ""
echo "🚀 Setting up startup persistence..."

# Create systemd service for startup cleanup
SERVICE_FILE="/etc/systemd/system/files-cleanup-startup.service"

sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=File Upload System - Startup Cleanup
After=network.target

[Service]
Type=oneshot
User=$USER
WorkingDirectory=$BACKEND_DIR
ExecStart=/usr/bin/node $CLEANUP_SCRIPT
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable files-cleanup-startup.service

echo -e "${GREEN}✅ Startup service created and enabled${NC}"
echo "   Service: files-cleanup-startup.service"
echo "   Runs cleanup on every server boot"
echo ""

# Create manual cleanup script for convenience
MANUAL_SCRIPT="$BACKEND_DIR/run-cleanup.sh"

cat > "$MANUAL_SCRIPT" << 'EOF'
#!/bin/bash
# Manual cleanup script
echo "🧹 Running manual cleanup..."
cd /DATA/files_backend
node cleanup.js
echo ""
echo "✅ Done! Check /DATA/AppData/cleanup.log for details"
EOF

chmod +x "$MANUAL_SCRIPT"

echo -e "${GREEN}✅ Manual cleanup script created${NC}"
echo "   Location: $MANUAL_SCRIPT"
echo ""

echo "======================================================"
echo -e "${GREEN}✅ Setup Complete!${NC}"
echo "======================================================"
echo ""
echo "📋 Summary:"
echo "   • Cron job: Runs every 6 hours"
echo "   • Startup: Runs on server boot"
echo "   • Logs: $LOG_FILE"
echo ""
echo "🔧 Useful commands:"
echo "   • View cron jobs:    crontab -l"
echo "   • Manual cleanup:    $MANUAL_SCRIPT"
echo "   • View logs:         tail -f $LOG_FILE"
echo "   • Test startup:      sudo systemctl start files-cleanup-startup"
echo "   • Check service:     sudo systemctl status files-cleanup-startup"
echo ""
echo "⏰ Next automatic cleanup will run in ~6 hours"
echo ""