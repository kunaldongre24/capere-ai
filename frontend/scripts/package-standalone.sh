#!/usr/bin/env bash
set -euo pipefail

destination=.next/standalone/node_modules
mkdir -p "$destination"

# Next's file tracing does not follow the complete firebase-admin dependency
# graph through pnpm's virtual store. Copy the resolved production packages
# into the standalone runtime so App Hosting can load server-only auth routes.
for package in node_modules/.pnpm/*/node_modules/*; do
  [[ -d "$package" ]] || continue
  name="$(basename "$package")"
  if [[ "$name" == @* ]]; then
    mkdir -p "$destination/$name"
    for child in "$package"/*; do
      [[ -e "$child" ]] || continue
      rm -rf "$destination/$name/$(basename "$child")"
      cp -RL "$child" "$destination/$name/"
    done
  else
    rm -rf "$destination/$name"
    cp -RL "$package" "$destination/"
  fi
done

# Keep the known Next runtime versions deterministic if multiple pnpm package
# versions were encountered while flattening the virtual store.
mkdir -p "$destination/@next" "$destination/@swc"
rm -rf "$destination/next" "$destination/@next/env" \
  "$destination/styled-jsx" "$destination/@swc/helpers" \
  "$destination/react" "$destination/react-dom"
cp -RL node_modules/next "$destination/"
cp -RL node_modules/@next/env "$destination/@next/"
cp -RL node_modules/styled-jsx "$destination/"
cp -RL node_modules/@swc/helpers "$destination/@swc/"
cp -RL node_modules/react node_modules/react-dom "$destination/"
