// Learn more https://docs.expo.io/guides/customizing-metro
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * three ships a CommonJS entry that calls `process.emitWarning()` before
 * re-exporting the ES module. React Native's `process` shim doesn't implement
 * that method, so anything requiring `three` (@react-three/fiber's CJS dist,
 * for one) dies with "undefined is not a function" at import time. Resolving
 * the package straight to its ES build skips the deprecated shim entirely.
 */
const THREE_ESM = path.join(__dirname, 'node_modules/three/build/three.module.js');

/**
 * Metro treats an unknown extension as source and tries to parse it, so a .glb
 * has to be declared an asset before `require()` on one will resolve to
 * something expo-asset can fetch.
 */
config.resolver.assetExts = [...config.resolver.assetExts, 'glb'];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'three') {
    return { type: 'sourceFile', filePath: THREE_ESM };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
