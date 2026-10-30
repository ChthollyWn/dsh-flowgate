/**
 * Public API of the shell module. The rule engine imports only from here.
 */
export type {
  ParsedCommand,
  CommandSegment,
  SegmentSeparator,
} from './tokenize'
export {
  tokenizeShell,
  parseCommands,
  parseCommandLine,
  commandNames,
  firstCommandName,
} from './tokenize'
export {
  classifyShellCommand,
  dangerousCommandReasons,
  isDangerousCommand,
  isPushCommand,
  isDependencyCommand,
  isTestCommand,
  isBuildCommand,
  isLintCommand,
  isMutatingCommand,
  isRevertCommand,
  validateVerifyCommand,
  extractWriteTargets,
} from './classify'
