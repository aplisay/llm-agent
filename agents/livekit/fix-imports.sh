#!/bin/bash

# Copy agent-lib files to dist (already done by tsup onSuccess)
# The files are already copied, now we need to ensure they work with ES modules

# Convert agent-lib .js files to .mjs for ES module compatibility
cd dist/agent-lib
for file in *.js; do
    if [ -f "$file" ]; then
        mv "$file" "${file%.js}.mjs"
    fi
done

# Convert .js files in subdirectories to .mjs
find . -name "*.js" -type f | while read file; do
    if [ -f "$file" ]; then
        mv "$file" "${file%.js}.mjs"
    fi
done
cd ../..

# Update import statements in compiled JS files to use .mjs extension
find dist -name '*.js' -exec sed -i '' 's/agent-lib\/\([^.]*\)"/agent-lib\/\1.mjs"/g' {} \;
find dist -name '*.js' -exec sed -i '' 's/from "\.\/lib\/\([^"]*\)"/from "\.\/lib\/\1.js"/g' {} \;
find dist -name '*.js' -exec sed -i '' 's/from "\.\/lib\/worker"/from "\.\/lib\/worker.js"/g' {} \;

# Update internal imports in agent-lib files
find dist/agent-lib -name '*.mjs' -exec sed -i '' 's/from '\''\.\/\([^'\'']*\)\.js'\''/from '\''\.\/\1.mjs'\''/g' {} \;
find dist/agent-lib -name '*.mjs' -exec sed -i '' 's/from '\''\.\/\([^'\'']*\)'\''/from '\''\.\/\1.mjs'\''/g' {} \;
find dist/agent-lib -name '*.mjs' -exec sed -i '' 's/from '\''\.\.\/\([^'\'']*\)\.js'\''/from '\''\.\.\/\1.mjs'\''/g' {} \;
find dist/agent-lib -name '*.mjs' -exec sed -i '' 's/from '\''\.\.\/\([^'\'']*\)'\''/from '\''\.\.\/\1.mjs'\''/g' {} \;

# Fix double .mjs extensions
find dist/agent-lib -name '*.mjs' -exec sed -i '' 's/\.mjs\.mjs/.mjs/g' {} \; 