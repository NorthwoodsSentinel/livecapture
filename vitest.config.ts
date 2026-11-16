// Test and coverage config. The coverage bar is the source's (Cliff Hall's inspector): >= 90 on all four
// dimensions, per file, enforced here and therefore in `bun run test` and CI. Never lower it to pass;
// see AGENTS.md "Always test new or modified code".
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "tools/**/*.ts"],
      exclude: [
        // Exact path, never a glob. A command-line script: it runs main() on import, shells out to
        // ffmpeg/ffprobe and posts to a live deployment, so it cannot be measured without restructuring it.
        // Follow-up: NOR-381 child ticket for livecapture (split pure helpers out, then test them).
        "tools/replay-file.ts",
      ],
      reporter: [["text", { skipFull: false }], "json-summary"],
      thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
