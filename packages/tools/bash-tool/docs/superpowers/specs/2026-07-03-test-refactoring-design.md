# 测试重构设计：Playground 脚本转 Vitest 测试

**日期**：2026-07-03  
**状态**：已批准

## 背景

当前 `tests/` 目录下的文件（rm.ts、mv.ts、cp.ts 等）是 playground 演示脚本，仅打印命令输出，不进行结果验证。需要将其转换为正式的 Vitest 自动化测试。

## 设计决策

### 1. 测试框架选择

**决策**：使用 Vitest，与项目现有测试框架一致。

### 2. `run` 函数改造

**决策**：修改 `run` 函数返回 `RunResult` 对象，保留原有打印功能。

```typescript
export interface RunResult {
  output: string;      // 命令输出文本
  exitCode: number | null;  // 退出码
  error?: boolean;     // 是否抛出异常
}
```

### 3. 测试文件组织

**决策**：每个命令一个测试文件，保持当前结构。

- `rm.ts` → `rm.test.ts`
- `mv.ts` → `mv.test.ts`
- `cp.ts` → `cp.test.ts`
- 以此类推

### 4. 网络测试处理

**决策**：保留网络测试（curl、wget），添加超时和容错机制。

- 超时设置：30 秒
- 成功时验证内容，失败时跳过断言
- 无效 URL 测试仍验证错误处理

### 5. 清理策略

**决策**：使用 `afterEach` 清理测试文件，避免测试间干扰。

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/helpers.ts` | 修改 | `run` 函数返回 `RunResult` |
| `tests/rm.ts` → `tests/rm.test.ts` | 重写 | 转换为 Vitest 格式 |
| `tests/mv.ts` → `tests/mv.test.ts` | 重写 | 转换为 Vitest 格式 |
| `tests/cp.ts` → `tests/cp.test.ts` | 重写 | 转换为 Vitest 格式 |
| `tests/mkdir.ts` → `tests/mkdir.test.ts` | 重写 | 转换为 Vitest 格式 |
| `tests/sed.ts` → `tests/sed.test.ts` | 重写 | 转换为 Vitest 格式 |
| `tests/awk.ts` → `tests/awk.test.ts` | 重写 | 转换为 Vitest 格式 |
| `tests/grep.ts` → `tests/grep.test.ts` | 重写 | 转换为 Vitest 格式 |
| `tests/git.ts` → `tests/git.test.ts` | 重写 | 转换为 Vitest 格式 |
| `tests/curl.ts` → `tests/curl.test.ts` | 重写 | 转换为 Vitest 格式，添加网络容错 |
| `tests/wget.ts` → `tests/wget.test.ts` | 重写 | 转换为 Vitest 格式，添加网络容错 |
| `tests/ls.ts` | 删除 | 仅是演示脚本，无测试价值 |
| `tests/index.ts` | 删除 | 旧的入口文件，不再需要 |

## 测试示例

### rm.test.ts

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { run, PLAYGROUND_DIR } from "./helpers.js";
import { execSync } from "node:child_process";

afterEach(() => {
  try {
    execSync("rm -f _test_rm*.txt && rm -rf _test_rm_dir", { cwd: PLAYGROUND_DIR });
  } catch {}
});

describe("rm - 删除文件", () => {
  it("should delete a single file", async () => {
    await run("echo 'temporary test file' > _test_rm.txt", "setup");
    const { exitCode: lsExit } = await run("ls _test_rm.txt", "verify-created");
    expect(lsExit).toBe(0);
    
    const { exitCode: rmExit } = await run("rm _test_rm.txt", "rm-file");
    expect(rmExit).toBe(0);
    
    const { output } = await run("ls _test_rm.txt 2>&1 || echo '(file removed)'", "verify-removed");
    expect(output).toContain("(file removed)");
  });

  it("should fail when deleting nonexistent file", async () => {
    const { exitCode } = await run("rm nonexistent_file_xyz_12345", "rm-nonexistent");
    expect(exitCode).not.toBe(0);
  });
});
```

### curl.test.ts（网络容错示例）

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { run, PLAYGROUND_DIR } from "./helpers.js";
import { execSync } from "node:child_process";

const NETWORK_TIMEOUT = 30_000;

afterEach(() => {
  try {
    execSync("rm -f _test_curl_*.txt", { cwd: PLAYGROUND_DIR });
  } catch {}
});

describe("curl - HTTP 请求", () => {
  it("should perform GET request", async () => {
    const { exitCode, output } = await run(
      "curl -s --max-time 10 https://httpbin.org/get | head -20",
      "get-request"
    );
    if (exitCode === 0) {
      expect(output).toContain('"url"');
    }
  }, NETWORK_TIMEOUT);

  it("should handle invalid URL gracefully", async () => {
    const { exitCode, output } = await run(
      "curl -s --max-time 5 https://invalid-domain-xyz-12345.com 2>&1 || echo '(DNS resolution failed)'",
      "invalid-url"
    );
    expect(exitCode).not.toBe(0);
    expect(output).toContain("DNS resolution failed");
  }, NETWORK_TIMEOUT);
});
```

## 验证方式

1. 运行 `npm test` 确保所有测试通过
2. 运行 `npx vitest run tests/` 单独运行测试目录
3. 检查测试覆盖率（可选）
