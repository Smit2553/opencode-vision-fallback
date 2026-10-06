import { Plugin } from "@opencode/plugin";
import { createImageFallback } from "./fallback.js";

export default Plugin.define({
  id: "opencode-vision-fallback",
  async setup(ctx) {
    const rewrite = createImageFallback(ctx);
    for (const kind of /** @type {const} */ (["context", "compaction", "generate", "title"])) {
      await ctx.session.hook(kind, rewrite);
    }
    return () => rewrite.clear();
  },
});
