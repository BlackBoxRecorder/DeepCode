/**
 * runner — unified Agent Loop mode abstractions.
 *
 * Re-exports the AgentRunner interface, AgentMode type, event types,
 * and the default ReActRunner implementation.
 */
export { type AgentMode, type AgentRunner } from "./types.js";
export { ReActRunner } from "./react-runner.js";
export {
  PlanExecuteRunner,
  stripMarkdownCodeFences,
} from "./plan-execute-runner.js";
export { LoopEngineeringRunner } from "./loop-engineering-runner.js";
export type {
  VerificationResult,
  Verifier,
} from "./loop-engineering-runner.js";

// Event types — per-mode + combined union
export type {
  AgentStreamEvent,
  PlanExecuteEvent,
  LoopEngineeringEvent,
  RunnerStreamEvent,
  Plan,
  PlanTask,
} from "./events.js";
