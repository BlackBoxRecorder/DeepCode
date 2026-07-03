# @timetickme/bash-tool 架构设计文档

**目标受众**：现有贡献者  
**最后更新**：2026-07-03  
**文档类型**：核心架构与关键实现详解

## 1. 项目概述

`@timetickme/bash-tool` 是一个轻量级、可插拔的 bash 命令执行工具，专为 AI 代理设计。它提供类型安全的 API，支持超时控制、取消、流式输出和输出截断。

**核心能力**：
- **轻量**：仅依赖 Node 标准库，无第三方运行时依赖
- **可插拔**：支持自定义 Shell 后端、spawn hook、mock backend
- **类型安全**：完整的 TypeScript 类型定义
- **流式输出**：支持实时输出更新，带节流控制
- **超时与取消**：通过 AbortSignal 实现命令取消和超时
- **输出截断**：自动截断大型输出，保留最后 N 行/字节

## 2. 架构设计

### 2.1 设计模式

项目采用**策略模式**（Strategy Pattern）实现命令执行的可插拔性。核心接口 `BashOperations` 定义了执行后端的契约，允许在真实 Shell 执行和模拟实现之间无缝切换。

### 2.2 模块划分

#### 入口模块 (`src/index.ts`)
- 重新导出所有公共 API，提供统一的导入路径
- 包括类型、工厂函数、操作实现和工具函数

#### 核心实现 (`src/bash.ts`)
- 包含 `createBashTool()` 工厂函数
- 通过闭包捕获配置（cwd、operations、commandPrefix、spawnHook）
- 返回一个异步执行函数，处理命令执行、输出流、错误处理

#### 操作模块 (`src/operations/`)
- **`local.ts`**：真实 Shell 执行后端
  - 使用 `child_process.spawn()` 执行命令
  - 支持进程组管理（Unix 上使用 `-pid`）
  - 验证工作目录存在性
- **`mock.ts`**：测试替身后端
  - 支持配置响应、延迟和错误
  - 用于单元测试和模拟场景

#### 工具模块 (`src/utils/`)
- **`output.ts`**：`OutputAccumulator` 类
  - 支持流式输出累积
  - 自动截断（默认 1000 行或 1MB）
  - 超出限制时创建临时文件保存完整输出
- **`shell.ts`**：平台感知的 Shell 配置
  - 获取 Shell 路径和环境变量
  - 剥离 ANSI 转义序列
  - 清理二进制输出
- **`process.ts`**：进程树管理
  - 终止进程树（`killProcessTree`）
  - 等待进程结束（`waitForChildProcess`）
  - 检查进程状态（`isProcessRunning`）

### 2.3 依赖关系

```
src/bash.ts
├── src/operations/local.ts (默认)
├── src/utils/output.ts
├── src/utils/shell.ts
└── src/types.ts

src/operations/local.ts
├── src/utils/process.ts
├── src/utils/shell.ts
└── src/types.ts

src/operations/mock.ts
└── src/types.ts
```

## 3. 核心模块详解

### 3.1 `src/bash.ts`：工厂函数与执行流程

#### `createBashTool(cwd, options?)`
- **参数**：
  - `cwd`：命令执行的工作目录
  - `options`：可选配置（operations、commandPrefix、shellPath、spawnHook）
- **返回**：`BashToolFunction` 类型的异步函数

#### 执行流程：
1. **配置解析**：合并默认配置与用户选项
2. **命令预处理**：应用 commandPrefix 和 spawnHook
3. **输出初始化**：创建 `OutputAccumulator` 实例
4. **流式输出设置**：配置节流更新（默认 100ms）
5. **命令执行**：调用 `ops.exec()` 执行命令
6. **错误处理**：捕获中止、超时和执行错误
7. **结果格式化**：处理截断信息，生成最终结果

#### 关键闭包变量：
- `ops`：执行后端（默认 `createLocalBashOperations`）
- `commandPrefix`：命令前缀
- `spawnHook`：spawn 上下文钩子

### 3.2 `src/types.ts`：类型系统设计

#### 核心类型：
- **`BashToolFunction`**：主调用类型 `(params, options?) => Promise<BashResult>`
- **`BashOperations`**：可插拔执行后端接口
- **`BashSpawnContext` / `BashSpawnHook`**：执行前命令修改钩子
- **`TruncationResult`**：详细的截断元数据

#### 类型层次：
```
BashResult
├── content: ContentItem[]
├── details?: BashDetails
└── terminate?: boolean

BashDetails
├── exitCode: number | null
├── truncated?: boolean
├── fullOutputPath?: string
└── cancelled?: boolean
```

### 3.3 `src/operations/`：策略接口与实现

#### `BashOperations` 接口
```typescript
interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}
```

#### `local.ts` 实现细节：
- 使用 `child_process.spawn()` 执行命令
- 默认 Shell 路径：`/bin/bash`（可通过 `shellPath` 选项自定义）
- 在 Unix 上创建 detached 进程，使用进程组管理
- 验证工作目录存在性，抛出明确错误
- 处理信号传递和超时机制

#### `mock.ts` 实现细节：
- 支持配置响应数据、延迟和错误
- 用于测试 `bash.ts` 的核心逻辑
- 可模拟各种执行场景（成功、失败、超时）

### 3.4 `src/utils/`：工具模块

#### `OutputAccumulator` 类
- **构造函数**：`new OutputAccumulator(options?)`
  - `tempFilePrefix`：临时文件前缀
  - `maxLines`：最大行数（默认 1000）
  - `maxBytes`：最大字节数（默认 1MB）
- **关键方法**：
  - `append(text)`：追加输出文本
  - `finish()`：完成输出收集
  - `snapshot(options?)`：获取当前输出快照
  - `closeTempFile()`：关闭临时文件

#### 截断策略：
- 保留**最后** N 行/字节（尾部行为），而不是开头
- 超出限制时创建临时文件保存完整输出
- 提供详细的截断元数据（`TruncationResult`）

#### `shell.ts` 工具函数：
- `getShellConfig(shellPath?)`：获取平台相关的 Shell 配置
  - Windows：默认 `cmd.exe`，参数 `['/c']`
  - Unix：默认 `/bin/bash`，参数 `['-c']`
  - 返回 `ShellConfig` 对象（shell、args、commandTransport）
- `getShellEnv(env?)`：获取 Shell 环境变量
  - 合并 `process.env` 和自定义环境变量
  - 确保 `PATH` 始终存在
- `stripAnsi(text)`：剥离 ANSI 转义序列
- `sanitizeBinaryOutput(text)`：清理二进制输出
  - 移除空字节和控制字符
  - 规范化换行符
- `formatSize(bytes)`：格式化字节大小

#### `process.ts` 进程管理：
- `killProcessTree(pid, signal?)`：终止进程树
  - 在 Windows 上使用 `taskkill /T /F /PID`
  - 在 Unix 上使用 `-pid` 信号终止进程组
  - 默认信号：`SIGTERM`
- `waitForChildProcess(child)`：等待子进程结束
- `isProcessRunning(pid)`：检查进程是否运行

## 4. 关键数据流

### 4.1 命令执行流程

```
用户调用 bashTool(params, options)
    ↓
命令预处理（commandPrefix + spawnHook）
    ↓
创建 OutputAccumulator
    ↓
调用 ops.exec(command, cwd, options)
    ↓
流式输出处理（节流 100ms）
    ↓
错误处理（中止/超时/执行错误）
    ↓
结果格式化（截断信息）
    ↓
返回 BashResult
```

### 4.2 输出流与截断机制

```
命令输出 → onData 回调
    ↓
sanitizeBinaryOutput + stripAnsi
    ↓
OutputAccumulator.append()
    ↓
检查截断条件（行数/字节数）
    ↓
如果超出限制：
  1. 创建临时文件保存完整输出
  2. 保留最后 N 行/字节
  3. 生成 TruncationResult
    ↓
scheduleOutputUpdate() 节流更新
    ↓
emitOutputUpdate() 调用 onUpdate 回调
```

### 4.3 错误处理与传播

```
ops.exec() 抛出错误
    ↓
捕获错误类型：
  - "aborted"：命令中止
  - "timeout:X"：命令超时
  - 其他错误：直接抛出
    ↓
finishOutput() 收集当前输出
    ↓
formatOutput() 格式化输出文本
    ↓
将输出文本添加到错误消息前面
    ↓
抛出包含输出上下文的错误
```

## 5. 重要实现细节

### 5.1 输出节流（100ms）

**目的**：避免频繁调用 `onUpdate` 回调，防止性能问题。

**实现**：
- 使用 `setTimeout` 和 `Date.now()` 实现节流
- 默认节流间隔：100ms
- 在每次 `onData` 回调中调用 `scheduleOutputUpdate()`
- 如果距离上次更新超过 100ms，立即触发更新
- 否则设置定时器，在延迟后触发更新

**关键代码**（`src/bash.ts`）：
```typescript
const DEFAULT_UPDATE_THROTTLE_MS = 100;

const scheduleOutputUpdate = () => {
  if (!onUpdate) return;
  updateDirty = true;
  const delay = DEFAULT_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
  if (delay <= 0) {
    clearUpdateTimer();
    emitOutputUpdate();
    return;
  }
  updateTimer ??= setTimeout(() => {
    updateTimer = undefined;
    emitOutputUpdate();
  }, delay);
};
```

### 5.2 进程清理（进程组）

**目的**：可靠地终止整个进程树，避免僵尸进程。

**实现**：
- 在 Unix 上使用 `detached: true` 创建进程组
- 使用 `-pid` 信号终止整个进程组
- 在 Windows 上使用 `taskkill /T /F /PID` 终止进程树

**关键代码**（`src/operations/local.ts`）：
```typescript
const child = spawn(shellPath, ['-c', command], {
  cwd,
  env,
  detached: true,  // Unix 进程组
  stdio: ['pipe', 'pipe', 'pipe'],
});

// 终止进程组
process.kill(-child.pid, 'SIGTERM');
```

### 5.3 信号处理（AbortSignal）

**目的**：支持命令取消和超时。

**实现**：
- 接收 `AbortSignal` 参数
- 监听 `abort` 事件
- 当信号中止时，终止进程并抛出错误
- 超时通过 `setTimeout` 实现，触发 `AbortSignal`

**关键代码**（`src/bash.ts`）：
```typescript
if (signal) {
  signal.addEventListener('abort', () => {
    // 终止进程
    ops.exec(...)  // 内部处理中止
  });
}
```

## 6. 扩展点

### 6.1 添加新的执行后端

1. 实现 `BashOperations` 接口
2. 在 `createBashTool` 中通过 `options.operations` 传入
3. 示例：远程 Shell 执行、容器内执行

```typescript
const customOps: BashOperations = {
  exec: async (command, cwd, options) => {
    // 自定义执行逻辑
    return { exitCode: 0 };
  }
};

const bashTool = createBashTool('/path', { operations: customOps });
```

### 6.2 自定义 spawnHook

1. 实现 `BashSpawnHook` 类型
2. 在 `createBashTool` 中通过 `options.spawnHook` 传入
3. 用于修改命令、工作目录或环境变量

```typescript
const customHook: BashSpawnHook = (context) => {
  // 修改命令或环境
  return {
    ...context,
    command: `custom-prefix ${context.command}`,
    env: { ...context.env, CUSTOM_VAR: 'value' }
  };
};

const bashTool = createBashTool('/path', { spawnHook: customHook });
```

### 6.3 自定义输出处理

1. 通过 `onUpdate` 回调接收流式输出
2. 实现自定义输出处理逻辑
3. 可用于日志记录、实时分析等

```typescript
const result = await bashTool(
  { command: 'long-running-command' },
  {
    onUpdate: (result) => {
      // 自定义输出处理
      console.log('Output update:', result.content[0].text);
    }
  }
);
```

## 附录：关键文件参考

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 入口点，重新导出所有公共 API |
| `src/bash.ts` | 核心工厂函数和执行逻辑 |
| `src/types.ts` | 类型定义 |
| `src/operations/local.ts` | 真实 Shell 执行后端 |
| `src/operations/mock.ts` | 测试替身后端 |
| `src/utils/output.ts` | 输出累积和截断 |
| `src/utils/shell.ts` | Shell 配置和文本处理 |
| `src/utils/process.ts` | 进程管理 |
