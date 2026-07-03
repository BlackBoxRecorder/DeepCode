import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // 测试文件共享 playground 目录，必须顺序执行以避免文件冲突
    fileParallelism: false,
  },
});
