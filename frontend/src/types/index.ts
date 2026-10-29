export type AuthMethod = 'password' | 'key'
export type Environment = 'development' | 'staging' | 'production'

export interface RetryPolicy {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitter: boolean
}

export interface PoolSettings {
  maxConnections: number
  acquireTimeoutMs: number
  idleTimeoutSecs: number
}

export interface Profile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  keyPath?: string | null
  color: string
  environment: string
  tags: string[]
  retry: RetryPolicy
  pool: PoolSettings
  keepaliveSecs: number
  connectTimeoutSecs: number
  elevated: boolean
  createdAt: number
  updatedAt: number
  hasPassword: boolean
  hasPrivateKey: boolean
  hasPassphrase: boolean
}

export interface ProfileInput {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  password?: string | null
  privateKey?: string | null
  passphrase?: string | null
  keyPath?: string | null
  clearPrivateKey?: boolean
  clearKeyPath?: boolean
  color: string
  environment: string
  tags: string[]
  retry: RetryPolicy
  pool: PoolSettings
  keepaliveSecs: number
  connectTimeoutSecs: number
  elevated: boolean
}

export interface DetectedWebServer {
  name: string
  binary: string
  version: string
  active: boolean
}

export interface ServerInfo {
  hostname: string
  osName: string
  osVersion: string
  distroId: string
  distroFamily: string
  kernel: string
  arch: string
  initSystem: string
  packageManager: string
  shell: string
  username: string
  isContainer: boolean
  cpuModel: string
  cpuCount: number
  memTotalKb: number
  webServers: DetectedWebServer[]
  fingerprint: string
  latencyMs: number
  detectedAt: number
}

export interface KeyProbe {
  path: string
  exists: boolean
  encrypted: boolean
  valid: boolean
  error: string | null
}

export interface TestResult {
  ok: boolean
  latencyMs: number
  server: ServerInfo | null
  error: string | null
}

export interface PoolStats {
  profileId: string
  maxConnections: number
  total: number
  idle: number
  inUse: number
  acquireTimeoutMs: number
}

export interface TerminalInfo {
  sessionId: string
  profileId: string
  title: string
  cols: number
  rows: number
}

export interface CpuCore {
  name: string
  usage: number
}

export interface ProcessInfo {
  pid: number
  user: string
  cpu: number
  mem: number
  rssKb: number
  command: string
}

export interface ProcessLocation {
  pid: number
  cwd: string | null
  exe: string | null
  command: string
  directory: string
  accessible: boolean
}

export interface DbInfo {
  installed: boolean
  client: string
  version: string
  hostname: string
  port: number
  socket: string
  serviceState: string
  canQuery: boolean
  error: string | null
}

export interface DbUser {
  user: string
  host: string
  plugin: string
  system: boolean
}

export interface DbLoginTest {
  ok: boolean
  output: string
  error: string | null
}

export interface DbPasswordResult {
  ok: boolean
  output: string
  exitCode: number
  test: DbLoginTest | null
}

export interface CronEntry {
  source: string
  schedule: string
  user: string | null
  command: string
  raw: string
  suspicious: boolean
}

export interface NodeProcess {
  pid: number
  user: string
  cpu: number
  mem: number
  rssKb: number
  elapsedSecs: number
  command: string
}

export interface ListeningPort {
  protocol: string
  local: string
  ip: string
  port: number
  process: string
  pid: number | null
  public: boolean
}

export interface NetworkConnection {
  protocol: string
  state: string
  local: string
  remote: string
  process: string
  pid: number | null
}

export interface NetworkReport {
  hostname: string
  generatedAt: number
  listening: ListeningPort[]
  connections: NetworkConnection[]
  listeningSummary: string[]
  stats: string[]
}

export interface SudoGroup {
  name: string
  gid: string
  members: string[]
}

export interface SudoRule {
  principal: string
  host: string
  runas: string
  nopasswd: boolean
  commands: string
  source: string
  raw: string
}

export interface SudoAccount {
  user: string
  exists: boolean
  uid: string
  gid: string
  home: string
  shell: string
  passwordStatus: string
  lastLogin: string
  authorizedKeys: number
  groups: string
}

export interface SudoersReport {
  hostname: string
  generatedAt: number
  groups: SudoGroup[]
  rules: SudoRule[]
  accounts: SudoAccount[]
  rootAccounts: string[]
  configOk: boolean
  configOutput: string
}

export interface Pm2Process {
  id: number
  name: string
  namespace: string
  status: string
  pid: number | null
  uptimeMs: number | null
  restarts: number
  cpu: number
  memory: number
  mode: string
  script: string
  cwd: string
  version: string
  outLog: string
  errLog: string
}

export interface Pm2Report {
  available: boolean
  binary: string
  processes: Pm2Process[]
}

export interface Pm2Logs {
  id: number
  name: string
  outPath: string
  errPath: string
  stdout: string
  stderr: string
}

export type Pm2ActionKind = 'start' | 'stop' | 'restart' | 'reload' | 'delete'

export interface CronDeleteResult {
  source: string
  backup: string
  output: string
}

export interface CronBackupSummary {
  id: number
  timestamp: number
  profileId: string
  profileName: string
  source: string
  backupPath: string
  removed: number
  entries: string[]
}

export interface SuspectProcess {
  pid: number
  user: string
  exe: string
  started: string
  command: string
}

export interface SuspectFile {
  path: string
  mode: string
  owner: string
  size: number
  modified: string
}

export interface SuspectConnection {
  local: string
  remote: string
  ip: string
  port: number
  process: string
  pid: number | null
}

export interface IncidentScan {
  hostname: string
  generatedAt: number
  processes: SuspectProcess[]
  files: SuspectFile[]
  envHits: string[]
  connections: SuspectConnection[]
  authorizedKeys: string[]
  units: string[]
  shellHistory: string[]
  containers: string[]
}

export interface IncidentActionResult {
  ok: boolean
  output: string
}

export interface CronReport {
  hostname: string
  generatedAt: number
  serviceState: string
  entries: CronEntry[]
  timers: string[]
  atJobs: string[]
  errors: string[]
  recent: string[]
}

export interface SecurityFinding {
  id: string
  title: string
  severity: string
  category: string
  status: string
  detail: string
  evidence: string
  remediation: string
  fixable?: boolean
}

export interface SecurityFixResult {
  findingId: string
  ok: boolean
  output: string
}

export interface SecuritySummary {
  critical: number
  high: number
  medium: number
  low: number
  info: number
  passed: number
}

export interface SecurityReport {
  id: number | null
  timestamp: number
  profileId: string
  profileName: string
  hostname: string
  score: number
  summary: SecuritySummary
  findings: SecurityFinding[]
  cron: CronReport | null
  durationMs: number
}

export interface SecurityAuditSummary {
  id: number
  timestamp: number
  profileId: string
  profileName: string
  score: number
  critical: number
  high: number
  medium: number
  low: number
  findings: number
}

export interface SshKey {
  user: string
  path: string
  keyType: string
  comment: string
  fingerprint: string
  raw: string
}

export interface SshConfig {
  pubkeyAuthentication: string
  passwordAuthentication: string
  kbdInteractiveAuthentication: string
  permitRootLogin: string
  configTestOk: boolean
  dropinPresent: boolean
  dropinPath: string
  output: string
}

export interface SshActionResult {
  ok: boolean
  output: string
  config: SshConfig | null
}

export interface ExecutionLog {
  id: number
  timestamp: number
  profileId: string | null
  profileName: string | null
  category: string
  action: string
  target: string | null
  command: string | null
  status: string
  exitCode: number | null
  durationMs: number | null
  output: string | null
  error: string | null
  metadata: unknown
}

export interface LogQuery {
  profileId?: string
  category?: string
  status?: string
  search?: string
  limit?: number
  offset?: number
}

export interface LargeFile {
  path: string
  sizeHuman: string
  sizeBytes: number
}

export interface FileProperties {
  path: string
  fileType: string
  sizeBytes: number
  sizeHuman: string
  diskUsageHuman: string
  owner: string
  group: string
  mode: string
  modified: string
  accessed: string
  inode: number
  links: number
  target: string | null
}

export interface FileDeleteResult {
  path: string
  ok: boolean
  output: string
  exitCode: number
}

export interface ProcessKillResult {
  pid: number
  signal: string
  ok: boolean
  output: string
  exitCode: number
}

export interface MetricsSnapshot {
  timestamp: number
  hostname: string
  kernel: string
  uptimeSecs: number
  load1: number
  load5: number
  load15: number
  cpuTotal: number
  cores: CpuCore[]
  memTotalKb: number
  memUsedKb: number
  memAvailableKb: number
  swapTotalKb: number
  swapUsedKb: number
  netRxBps: number
  netTxBps: number
  diskTotalKb: number
  diskUsedKb: number
  processes: ProcessInfo[]
}

export interface WebServiceInfo {
  name: string
  installed: boolean
  binary: string
  version: string
  active: boolean
  serviceUnit: string
  configRoot: string
  configFile: string
  logFile: string
}

export interface ServiceStatus {
  service: string
  installed: boolean
  active: boolean
  state: string
  pid: number | null
  detail: string
}

export interface ConfigEntry {
  path: string
  size: number
  modified: string
}

export interface ConfigContent {
  path: string
  content: string
  truncated: boolean
}

export interface ServiceActionResult {
  ok: boolean
  action: string
  output: string
  exitCode: number
  backupPath: string | null
}

export interface ExecOutput {
  stdout: string
  stderr: string
  exitStatus: number
}

export type TabKind =
  | 'terminal'
  | 'monitor'
  | 'services'
  | 'audit'
  | 'database'
  | 'security'
  | 'network'
export type TabStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface WorkspaceTab {
  id: string
  kind: TabKind
  title: string
  profileId: string
  sessionId?: string
  processPid?: number
  directory?: string
  status: TabStatus
  error?: string
}

export interface MetricsHistory {
  cpu: number[]
  mem: number[]
  rx: number[]
  tx: number[]
}
