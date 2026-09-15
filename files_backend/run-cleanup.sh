#!/bin/bash
# Manual cleanup script
echo "🧹 Running manual cleanup..."
cd /DATA/files_backend
node cleanup.js
echo ""
echo "✅ Done! Check /DATA/AppData/cleanup.log for details"
