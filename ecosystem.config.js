module.exports = {
    apps: [
      {
        name: "faucet-testnet",
        script: "./node_modules/.bin/ts-node",
        args: "src/index.ts",
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: "1G",
      }
    ],
  };
