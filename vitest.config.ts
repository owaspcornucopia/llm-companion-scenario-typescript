import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/app.ts", "src/model-service.ts"],
      thresholds: { lines: 95, functions: 95, statements: 95, branches: 85 },
    },
  },
});