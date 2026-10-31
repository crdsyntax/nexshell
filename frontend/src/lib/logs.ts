const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g

export type LogKind = 'error' | 'stack' | 'warn' | 'success' | 'debug' | 'normal'

const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfatal\b/i,
  /\bpanic\b/i,
  /\bexception\b/i,
  /\bqueryfailed\w*/i,
  /\ber_[a-z_]+\b/i,
  /\bunknown column\b/i,
  /\beconnrefused\b/i,
  /\beconnreset\b/i,
  /\benoent\b/i,
  /\bunhandled\w*\b/i,
  /\buncaught\w*\b/i,
  /\bsegmentation fault\b/i,
]

const WARN_PATTERNS = [/\bwarn(ing)?\b/i, /\bdeprecated\b/i, /\bretry(ing)?\b/i]
const SUCCESS_PATTERNS = [/\bready\b/i, /\blistening\b/i, /\bstarted\b/i, /\bconnected\b/i]
const DEBUG_PATTERNS = [/\bdebug\b/i, /\btrace\b/i, /\bverbose\b/i]

export function stripAnsi(value: string): string {
  return value.replace(ANSI, '')
}

export function classifyLogLine(line: string): LogKind {
  const text = stripAnsi(line)
  if (ERROR_PATTERNS.some((pattern) => pattern.test(text))) return 'error'
  if (/^\s+at\s/.test(text)) return 'stack'
  if (WARN_PATTERNS.some((pattern) => pattern.test(text))) return 'warn'
  if (DEBUG_PATTERNS.some((pattern) => pattern.test(text))) return 'debug'
  if (SUCCESS_PATTERNS.some((pattern) => pattern.test(text))) return 'success'
  return 'normal'
}
