#!/bin/bash

# Copy agent-lib files to dist
cp -r agent-lib dist/

# Rename .js files to .cjs in dist/agent-lib
cd dist/agent-lib
for file in *.js; do
    mv "$file" "${file%.js}.cjs"
done
cd ../..

# Update import statements in compiled JS files
find dist -name '*.js' -exec sed -i '' 's/agent-lib\/\([^.]*\)\.js/agent-lib\/\1.cjs/g' {} \;

# Update require statements in CommonJS files
find dist/agent-lib -name '*.cjs' -exec sed -i '' 's/require('\''\.\/\([^.]*\)'\'')/require('\''\.\/\1.cjs'\'')/g' {} \; 