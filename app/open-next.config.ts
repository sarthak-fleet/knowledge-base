import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Use CF Workers Static Assets as the incremental cache.
// This is the right override when the app is fully prerendered.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
