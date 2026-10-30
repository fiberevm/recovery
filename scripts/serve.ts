/**
 * Serves the release build locally, rebuilding it on every page load so a refresh shows edits.
 * Bun's own dev server injects an HMR WebSocket, which the page's `connect-src 'none'` policy
 * blocks; Safari treats that as a script error and the app never starts.
 */
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404 });

    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: `${import.meta.dir}/..` });
    if (build.exitCode !== 0) {
      return new Response(build.stderr.toString() || build.stdout.toString(), { status: 500 });
    }
    return new Response(Bun.file(`${import.meta.dir}/../dist/index.html`), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
});

console.log(`Serving the release build at http://localhost:${port}/ (refresh to rebuild)`);
