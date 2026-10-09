#!/usr/bin/env node
// FreeCodeZ W-32 CLI 壳：升级手动跑入口（核心逻辑在 src/main/legacyComputerUseMigration.js）。
import {
  planLegacyComputerUseMigration,
  runLegacyComputerUseMigration,
} from "../src/main/legacyComputerUseMigration.js";

const results = runLegacyComputerUseMigration(planLegacyComputerUseMigration(), {
  log: (message) => console.log(message),
});
console.log(`[migrate-computer-use] ${results.length} actions processed`);
