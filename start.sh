#!/bin/bash

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Music Discord Rich Presence Launcher
# Make sure to set your Discord Client ID below!

if [ -z "$DISCORD_CLIENT_ID" ]; then
    echo "Error: DISCORD_CLIENT_ID environment variable is not set."
    echo "Please set it to your Discord Application ID."
    echo ""
    echo "Example: DISCORD_CLIENT_ID=123456789 ./start.sh"
    echo ""
    echo "To get a Client ID:"
    echo "  1. Go to https://discord.com/developers/applications"
    echo "  2. Create a new application"
    echo "  3. Copy the Application ID"
    exit 1
fi

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check if the compiled binary exists
if [ -f "$SCRIPT_DIR/music-discord-presence" ]; then
    echo "Starting Music Discord Presence..."
    DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID" "$SCRIPT_DIR/music-discord-presence"
else
    # Fall back to running with bun
    if command -v bun &> /dev/null; then
        echo "Starting Music Discord Presence (via Bun)..."
        cd "$SCRIPT_DIR"
        DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID" bun run index.ts --tray
    else
        echo "Error: Neither the compiled binary nor Bun was found."
        echo "Please either:"
        echo "  1. Build the app: bun run build"
        echo "  2. Install Bun: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
fi
