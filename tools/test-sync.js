// Standalone test: start the SyncServer (no Electron) and verify MCP→WS flow.
const { SyncServer } = require("../dist/main/sync-server");

(async () => {
  const sync = new SyncServer();
  await sync.start();
  console.log("[test] sync server listening");

  // Keep alive for 8 seconds for an external MCP client to connect.
  setTimeout(() => {
    console.log("[test] shutting down");
    console.log("[test] final canvas size:", sync.state.canvas.width, "x", sync.state.canvas.height);
    process.exit(0);
  }, 8000);
})();
