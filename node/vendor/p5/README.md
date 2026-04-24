# Vendored p5.js

## What
`p5.min.js` here is a checked-in copy of p5.js, served by the stage
server at `/vendor/p5/p5.min.js` and loaded by the sandbox iframe.

The iframe runs under CSP `script-src 'self' 'unsafe-eval'` — loading
p5 from a CDN would require adding that CDN origin to the directive.
We instead serve it from our own origin so the boundary stays narrow.

## Source and version
- Upstream: https://github.com/processing/p5.js
- Version: 2.2.3
- License: LGPL-2.1 (see `LICENSE` in this directory)
- Bytes: `p5.min.js` should match `../../node_modules/p5/lib/p5.min.js`
  exactly for the same upstream version.

## Refresh procedure
When bumping p5:

1. Update the dependency in `node/package.json`:
   ```
   (cd node && npm install p5@<new-version>)
   ```
2. Copy the minified build into this directory:
   ```
   cp node/node_modules/p5/lib/p5.min.js node/vendor/p5/p5.min.js
   ```
3. If the upstream license text changed, refresh `LICENSE` from
   `node/node_modules/p5/license.txt`.
4. Update the Version line above to match the new number.
5. Run `node node/src/stage_server.mjs` — the self-test verifies the
   served bytes are the vendored bytes, not a CDN redirect.

## Why not serve from node_modules?
Two reasons:

1. `node_modules/` is reconstructed by `npm ci` in CI and deployment
   environments that may not pin the same transitive dep graph. The
   vendored copy is the contract.
2. The grep-guard in `stage_server.mjs` self-test asserts no CDN refs
   anywhere — that check is meaningful only when the p5 bytes live at
   a path we've committed, not at a path `npm install` could point
   at anything.
