#!/bin/bash
echo "===================================================="
echo "  SAGBI AGI Frontend Builder (TS to JS)"
echo "===================================================="

# Node.jsの確認
if ! command -v npm &> /dev/null; then
    echo "[Error] Node.js/npm is not installed."
    exit 1
fi

echo "[1/2] Installing dependencies..."
npm install

echo "[2/2] Transpiling TypeScript and Bundling..."
npm run build

echo ""
echo "===================================================="
echo "  Build Complete! "
echo "  Please upload the contents of the \"dist\" folder "
echo "  to your static hosting (Firebase, etc.)"
echo "===================================================="