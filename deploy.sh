#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

need_node=0
if ! command -v node >/dev/null 2>&1; then
  need_node=1
fi
if ! command -v npm >/dev/null 2>&1; then
  need_node=1
fi

if [ "$need_node" -eq 1 ]; then
  echo "Node.js and npm are required. I can try to install them with the package manager on this computer."
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    echo "Installing Node.js with apt..."
    sudo apt-get update
    sudo apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    echo "Installing Node.js with dnf..."
    sudo dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    echo "Installing Node.js with yum..."
    sudo yum install -y nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    echo "Installing Node.js with pacman..."
    sudo pacman -Sy --needed nodejs npm
  else
    echo "I could not find a supported package manager."
    echo "Install the current Node.js LTS from https://nodejs.org, then run ./deploy.sh again."
    exit 1
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm still were not found. Install Node.js LTS from https://nodejs.org, then rerun this script."
  exit 1
fi

node scripts/deploy.mjs
