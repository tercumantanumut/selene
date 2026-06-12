#!/usr/bin/env node

const fs = require("fs");

const outputPath = process.argv[process.argv.length - 1];

if (outputPath) {
  const payload = {
    pid: process.pid,
    execPath: process.execPath,
    argv: process.argv.slice(2),
    env: {
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
      npm_config_script_shell: process.env.npm_config_script_shell ?? null,
    },
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload), "utf8");
}

const timer = setInterval(() => {}, 1000);

function shutdown() {
  clearInterval(timer);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
