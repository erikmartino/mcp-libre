#!/bin/bash

# LibreOffice MCP Extension Build Script
# This script packages the extension into an .oxt file for installation

set -e

# Get script directory (works even if called from different location)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR"
BUILD_DIR="$SCRIPT_DIR/../build"
EXTENSION_NAME="libreoffice-mcp-extension"
VERSION="1.0.0"

echo "🏗️  Building LibreOffice MCP Extension v${VERSION}"

# Create build directory
echo "📁 Creating build directory..."
mkdir -p "$BUILD_DIR"
cd "$PLUGIN_DIR"

# Clean previous builds
rm -f "$BUILD_DIR/${EXTENSION_NAME}-${VERSION}.oxt"
rm -f "$BUILD_DIR/${EXTENSION_NAME}.oxt"

echo "📦 Packaging extension files..."

# Create the .oxt file (which is just a ZIP archive)
if command -v zip >/dev/null 2>&1; then
    zip -r "$BUILD_DIR/${EXTENSION_NAME}-${VERSION}.oxt" \
        META-INF/ \
        pythonpath/ \
        *.xml \
        *.xcu \
        *.txt \
        -x "*.pyc" "*/__pycache__/*"
else
    echo "ℹ️  'zip' command not found, using python3 zipfile..."
    python3 -c "
import os, zipfile
plugin_dir = os.getcwd()
oxt_path = os.path.join('$BUILD_DIR', '${EXTENSION_NAME}-${VERSION}.oxt')
with zipfile.ZipFile(oxt_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(plugin_dir):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for file in files:
            if file.endswith('.pyc'):
                continue
            rel_dir = os.path.relpath(root, plugin_dir)
            rel_path = os.path.normpath(os.path.join(rel_dir, file))
            if (rel_path.startswith('META-INF/') or 
                rel_path.startswith('pythonpath/') or
                (rel_dir == '.' and (file.endswith('.xml') or file.endswith('.xcu') or file.endswith('.txt')))):
                z.write(os.path.join(root, file), rel_path)
"
fi

# Create a symlink for easier access (or copy if symlinks not supported)
ln -sf "${EXTENSION_NAME}-${VERSION}.oxt" "$BUILD_DIR/${EXTENSION_NAME}.oxt" 2>/dev/null || \
    cp "$BUILD_DIR/${EXTENSION_NAME}-${VERSION}.oxt" "$BUILD_DIR/${EXTENSION_NAME}.oxt"

echo "✅ Extension built successfully!"
echo "📁 Output: $BUILD_DIR/${EXTENSION_NAME}-${VERSION}.oxt"
echo ""
echo "🚀 To install the extension:"
echo "   1. Open LibreOffice"
echo "   2. Go to Tools > Extension Manager"
echo "   3. Click 'Add' and select the .oxt file"
echo "   4. Restart LibreOffice"
echo ""
echo "🔧 Or install via command line:"
echo "   unopkg add \"$BUILD_DIR/${EXTENSION_NAME}-${VERSION}.oxt\""
echo ""
echo "🌐 After installation, the MCP server will be available at:"
echo "   http://localhost:8765"
