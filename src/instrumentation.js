export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs from the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Bring the background schedulers up at server boot rather than waiting for
    // the first page render. The root layout imports bootstrap too, but a layout
    // only runs when a page is requested — in a container nobody opens a
    // dashboard on, the quota auto-ping and MITM/tunnel watchdogs never started
    // at all. bootstrap.js is a no-op after the first call (global guard), so
    // whichever of the two paths wins, the work happens exactly once.
    //
    // Importing the source file from custom-server.js is not an option: the
    // runtime image ships src/ without the sibling modules these files import,
    // so those imports throw. Here the alias-resolved graph is already bundled.
    await import("@/shared/services/bootstrap.js");
  }
}
