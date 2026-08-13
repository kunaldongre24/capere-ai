#!/usr/bin/env bash
set -euo pipefail

destination=.next/standalone/node_modules
mkdir -p "$destination/@next" "$destination/@swc"
rm -rf "$destination/next" "$destination/@next/env" \
  "$destination/styled-jsx" "$destination/@swc/helpers" \
  "$destination/react" "$destination/react-dom"
cp -RL node_modules/next "$destination/"
cp -RL node_modules/@next/env "$destination/@next/"
cp -RL node_modules/styled-jsx "$destination/"
cp -RL node_modules/@swc/helpers "$destination/@swc/"
cp -RL node_modules/react node_modules/react-dom "$destination/"
