import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "{app,server,cli,schema}/**/*.test.ts"],
    // Media tests run ffmpeg on generated clips.
    testTimeout: 60_000,
  },
});
