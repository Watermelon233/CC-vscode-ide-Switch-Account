import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ─── 路径常量 ─────────────────────────────────────────────────────────────────

const HOME = os.homedir();
const SWITCH_DIR = path.join(HOME, '.cc-subscription-switch');
const ACCOUNTS_DIR = path.join(SWITCH_DIR, 'accounts');
const CONFIG_FILE = path.join(SWITCH_DIR, 'config.json');
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_CREDS = path.join(CLAUDE_DIR, '.credentials.json');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

interface Account {
  name: string;
  description?: string;
}

interface ApiProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
  description?: string;
}

type UsageSourceType = 'account' | 'api' | 'unknown';

interface UsageAttributionEvent {
  timestamp: number;
  sourceType: Exclude<UsageSourceType, 'unknown'>;
  sourceName: string;
}

interface StoredUsageCache {
  data: UsageData;
  fetchedAt: number;
}

interface Config {
  accounts: Account[];
  currentAccount?: string;
  apiProviders?: ApiProvider[];
  currentApiProvider?: string;
  usageAttributionHistory?: UsageAttributionEvent[];
  quotaUsageCache?: Record<string, StoredUsageCache>;
}

interface Credentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
    rateLimitTier?: string;
    billingType?: string;
    subscriptionCreatedAt?: string;
    profileFetchedAt?: number;
    scopes?: string[];
  };
}

interface ClaudeJson {
  oauthAccount?: {
    emailAddress?: string;
    displayName?: string;
    organizationName?: string;
  };
}

interface OAuthProfile {
  account?: {
    email?: string;
    display_name?: string;
    full_name?: string;
    has_claude_max?: boolean;
    has_claude_pro?: boolean;
  };
  organization?: {
    name?: string;
    organization_type?: string;
    billing_type?: string;
    rate_limit_tier?: string;
    subscription_created_at?: string;
    subscription_status?: string | null;
    claude_code_trial_ends_at?: string | null;
    claude_code_trial_duration_days?: number | null;
  };
}

interface AccountInfo {
  email: string;
  displayName: string;
  organization: string;
  plan: string;
  billingType: string;
  subscriptionCreatedAt: string;
  refreshToken: string;
  accessToken: string;
}

interface UsageWindow {
  utilization: number;
  resets_at?: string;
}

interface UsageData {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_sonnet: UsageWindow | null;
  seven_day_oauth_apps: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  extra_usage?: {
    is_enabled: boolean;
    used_credits: number | null;
    monthly_limit: number | null;
  };
}

interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  cost: number;
  requests: number;
}

interface ModelTokenStats extends TokenTotals {
  model: string;
}

interface DayModelTokenStats extends ModelTokenStats {
  date: string;
}

interface DailyTokenStats extends TokenTotals {
  date: string;
}

interface SourceTokenStats extends TokenTotals {
  sourceType: UsageSourceType;
  sourceName: string;
  sourceLabel: string;
}

interface SourceDailyTokenStats extends DailyTokenStats {
  sourceType: UsageSourceType;
  sourceName: string;
  sourceLabel: string;
}

interface SourceDayModelTokenStats extends DayModelTokenStats {
  sourceType: UsageSourceType;
  sourceName: string;
  sourceLabel: string;
}

interface SourceModelTokenStats extends ModelTokenStats {
  sourceType: UsageSourceType;
  sourceName: string;
  sourceLabel: string;
}

interface LocalTokenStats {
  totals: TokenTotals;
  byKind: Record<UsageSourceType, TokenTotals>;
  bySource: SourceTokenStats[];
  bySourceDay: SourceDailyTokenStats[];
  bySourceDayModel: SourceDayModelTokenStats[];
  byModel: ModelTokenStats[];
  byDayModel: DayModelTokenStats[];
  byDay: DailyTokenStats[];
  filesScanned: number;
  recordsScanned: number;
  updatedAt: number;
}

interface ModelPricing {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

interface ClaudeTranscriptEntry {
  timestamp?: string;
  type?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface OAuthTokenRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenUsed: string;
}

// ─── OAuth 常量 ───────────────────────────────────────────────────────────────

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URLS = [
  'https://api.anthropic.com/v1/oauth/token',
  'https://claude.ai/api/oauth/token',
];
const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TOKEN_REFRESH_SKEW_MS = 4 * 60 * 60 * 1000;
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// USD per 1M tokens, based on Anthropic's public first-party API pricing.
// Claude Code JSONL logs expose cache_creation_input_tokens without a cache
// duration, so cacheCreate uses the 5-minute cache write price.
const MODEL_PRICING: { match: RegExp; pricing: ModelPricing }[] = [
  { match: /(?:fable|mythos)[-_\s]?5/i, pricing: { input: 10, output: 50, cacheCreate: 12.5, cacheRead: 1 } },
  { match: /opus[-_\s]?4(?:[._-]?(?:8|7|6|5))/i, pricing: { input: 5, output: 25, cacheCreate: 6.25, cacheRead: 0.5 } },
  { match: /opus[-_\s]?4(?:[._-]?1)?(?:-\d{8})?$/i, pricing: { input: 15, output: 75, cacheCreate: 18.75, cacheRead: 1.5 } },
  { match: /opus/i, pricing: { input: 5, output: 25, cacheCreate: 6.25, cacheRead: 0.5 } },
  { match: /sonnet/i, pricing: { input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 } },
  { match: /haiku[-_\s]?3\.5|haiku[-_\s]?3-5/i, pricing: { input: 0.8, output: 4, cacheCreate: 1, cacheRead: 0.08 } },
  { match: /haiku/i, pricing: { input: 1, output: 5, cacheCreate: 1.25, cacheRead: 0.1 } },
];

// ─── 使用量缓存（内存，5分钟 TTL）────────────────────────────────────────────

const usageCache = new Map<string, { data: UsageData; fetchedAt: number }>();
const usageErrorByAccount = new Map<string, string>();
const usageRetryAfterByAccount = new Map<string, number>();
const tokenRefreshByKey = new Map<string, Promise<OAuthTokenRefreshResult | null>>();
const tokenRefreshErrorByKey = new Map<string, string>();
const tokenRefreshBlockedUntilByKey = new Map<string, number>();
let localStatsCache: { data: LocalTokenStats; fetchedAt: number } | undefined;
const CACHE_TTL = 5 * 60 * 1000;
const AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_MIN_COOLDOWN_MS = 5 * 1000;
const TOKEN_REFRESH_MAX_COOLDOWN_MS = 5 * 60 * 1000;
const USAGE_REQUEST_SPACING_MS = 350;
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_USAGE_STATS_DAYS = 7;
const HISTORY_DAILY_ROW_LIMIT = 180;

// ─── 配置文件操作 ─────────────────────────────────────────────────────────────

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Config;
    }
  } catch {}
  return { accounts: [] };
}

function saveConfig(config: Config): void {
  fs.mkdirSync(SWITCH_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function writeJsonFileAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tempPath, filePath);
}

function isUsageData(value: unknown): value is UsageData {
  const usage = value as Partial<UsageData> | undefined;
  return Boolean(
    usage?.five_hour &&
    typeof usage.five_hour.utilization === 'number' &&
    usage?.seven_day &&
    typeof usage.seven_day.utilization === 'number'
  );
}

function getStoredUsageCache(accountName: string): StoredUsageCache | undefined {
  const memoryCache = usageCache.get(accountName);
  if (memoryCache) {
    return memoryCache;
  }

  const stored = loadConfig().quotaUsageCache?.[accountName];
  if (!stored || !Number.isFinite(stored.fetchedAt) || !isUsageData(stored.data)) {
    return undefined;
  }
  usageCache.set(accountName, stored);
  return stored;
}

function setStoredUsageCache(accountName: string, data: UsageData): void {
  const stored = { data, fetchedAt: Date.now() };
  usageCache.set(accountName, stored);
  const config = loadConfig();
  config.quotaUsageCache = config.quotaUsageCache ?? {};
  config.quotaUsageCache[accountName] = stored;
  saveConfig(config);
}

function getNextQuotaRefreshAt(cache: StoredUsageCache): number {
  const resetAt = cache.data.five_hour.resets_at ? Date.parse(cache.data.five_hour.resets_at) : NaN;
  if (Number.isFinite(resetAt) && resetAt > cache.fetchedAt) {
    return resetAt + 60_000;
  }
  return cache.fetchedAt + 5 * 60 * 60 * 1000;
}

function shouldRefreshCachedQuota(cache: StoredUsageCache): boolean {
  return Date.now() >= getNextQuotaRefreshAt(cache);
}

function formatUsageCacheTime(timestamp: number): string {
  const date = new Date(timestamp);
  const today = formatLocalDate(new Date());
  const day = formatLocalDate(date);
  return date.toLocaleString('zh-CN', {
    month: day === today ? undefined : '2-digit',
    day: day === today ? undefined : '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatPlanLabel(plan: string | undefined, long = false): string {
  if (plan === 'pro') { return long ? 'Claude Pro' : 'Pro'; }
  if (plan === 'max') { return long ? 'Claude Max' : 'Max'; }
  return plan || '';
}

function formatBillingType(billingType: string | undefined): string {
  if (!billingType) { return ''; }
  return billingType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatProfileDate(value: string | undefined, compact = false): string {
  if (!value) { return ''; }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) { return value; }
  const date = new Date(timestamp);
  return compact
    ? date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
    : date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}

function appendUsageAttribution(
  config: Config,
  sourceType: Exclude<UsageSourceType, 'unknown'>,
  sourceName: string,
  timestamp = Date.now()
): void {
  config.usageAttributionHistory = config.usageAttributionHistory ?? [];
  const last = config.usageAttributionHistory[config.usageAttributionHistory.length - 1];
  if (last && last.sourceType === sourceType && last.sourceName === sourceName) {
    return;
  }
  config.usageAttributionHistory.push({ timestamp, sourceType, sourceName });
  localStatsCache = undefined;
}

function getSortedAttributionHistory(config: Config): UsageAttributionEvent[] {
  return (config.usageAttributionHistory ?? [])
    .filter((event) =>
      Number.isFinite(event.timestamp) &&
      (event.sourceType === 'account' || event.sourceType === 'api') &&
      Boolean(event.sourceName)
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

function getSourceLabel(sourceType: UsageSourceType, sourceName: string): string {
  if (sourceType === 'account') { return `账号: ${sourceName}`; }
  if (sourceType === 'api') { return `API: ${sourceName}`; }
  return '未归因';
}

function sourceKey(sourceType: UsageSourceType, sourceName: string): string {
  return `${sourceType}:${sourceName || 'unknown'}`;
}

function resolveUsageSourceAt(timestamp: number, history: UsageAttributionEvent[]): { sourceType: UsageSourceType; sourceName: string; sourceLabel: string } {
  if (!Number.isFinite(timestamp) || history.length === 0 || timestamp < history[0].timestamp) {
    return { sourceType: 'unknown', sourceName: 'unknown', sourceLabel: '未归因' };
  }

  let match = history[0];
  for (const event of history) {
    if (event.timestamp <= timestamp) {
      match = event;
    } else {
      break;
    }
  }
  return {
    sourceType: match.sourceType,
    sourceName: match.sourceName,
    sourceLabel: getSourceLabel(match.sourceType, match.sourceName),
  };
}

function ensureCurrentUsageAttribution(): void {
  const config = loadConfig();
  if (config.currentApiProvider) {
    appendUsageAttribution(config, 'api', config.currentApiProvider);
    saveConfig(config);
    return;
  }

  const currentAccount = detectCurrentAccount(config);
  if (currentAccount) {
    appendUsageAttribution(config, 'account', currentAccount);
    saveConfig(config);
  }
}

function getAccountDir(name: string): string {
  return path.join(ACCOUNTS_DIR, name);
}

function getAccountCredPath(name: string): string {
  return path.join(getAccountDir(name), '.credentials.json');
}

function getAccountClaudeJsonPath(name: string): string {
  return path.join(getAccountDir(name), '.claude.json');
}

function normalizeExpiresAt(expiresAt: number): number {
  // Claude Code currently stores milliseconds. Keep seconds support for older
  // or manually imported credentials.
  return expiresAt > 0 && expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt;
}

function shouldRefreshToken(expiresAt: number | undefined): boolean {
  if (!expiresAt) { return true; }
  return normalizeExpiresAt(expiresAt) <= Date.now() + TOKEN_REFRESH_SKEW_MS;
}

function tokenRefreshKey(refreshToken: string): string {
  return crypto.createHash('sha256').update(refreshToken).digest('hex');
}

function clampTokenRefreshCooldown(ms: number | undefined): number {
  const value = Number.isFinite(ms) ? (ms as number) : TOKEN_REFRESH_MIN_COOLDOWN_MS;
  return Math.min(TOKEN_REFRESH_MAX_COOLDOWN_MS, Math.max(TOKEN_REFRESH_MIN_COOLDOWN_MS, value));
}

function isEmptyQuotaWindow(data: UsageData): boolean {
  return (
    data.five_hour.utilization === 0 &&
    data.seven_day.utilization === 0 &&
    !data.five_hour.resets_at &&
    !data.seven_day.resets_at
  );
}

function readCredentialsFile(credPath: string): Credentials | null {
  try {
    if (!fs.existsSync(credPath)) { return null; }
    return JSON.parse(fs.readFileSync(credPath, 'utf-8')) as Credentials;
  } catch {
    return null;
  }
}

function readClaudeJsonEmail(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) { return undefined; }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ClaudeJson;
    return data.oauthAccount?.emailAddress?.toLowerCase();
  } catch {
    return undefined;
  }
}

function activeSessionMatchesAccount(accountName: string): boolean {
  const accountEmail = readClaudeJsonEmail(getAccountClaudeJsonPath(accountName));
  const activeEmail = readClaudeJsonEmail(path.join(CLAUDE_DIR, '.claude.json'));
  if (accountEmail && activeEmail) {
    return accountEmail === activeEmail;
  }

  const accountRefresh = readCredentialsFile(getAccountCredPath(accountName))?.claudeAiOauth?.refreshToken;
  const activeRefresh = readCredentialsFile(CLAUDE_CREDS)?.claudeAiOauth?.refreshToken;
  return Boolean(accountRefresh && activeRefresh && accountRefresh === activeRefresh);
}

function syncActiveCredentialsToCurrentAccount(config = loadConfig()): void {
  if (!config.currentAccount || config.currentApiProvider || !fs.existsSync(CLAUDE_CREDS)) {
    return;
  }
  if (!activeSessionMatchesAccount(config.currentAccount)) {
    return;
  }

  try {
    const accountDir = getAccountDir(config.currentAccount);
    fs.mkdirSync(accountDir, { recursive: true });
    fs.copyFileSync(CLAUDE_CREDS, getAccountCredPath(config.currentAccount));
    const activeClaudeJson = path.join(CLAUDE_DIR, '.claude.json');
    if (fs.existsSync(activeClaudeJson)) {
      fs.copyFileSync(activeClaudeJson, getAccountClaudeJsonPath(config.currentAccount));
    }
  } catch {}
}

// ─── 账户信息读取 ─────────────────────────────────────────────────────────────

function readAccountInfo(accountName: string): AccountInfo | null {
  try {
    const config = loadConfig();
    if (config.currentAccount === accountName && !config.currentApiProvider) {
      syncActiveCredentialsToCurrentAccount(config);
    }

    const credPath = getAccountCredPath(accountName);
    if (!fs.existsSync(credPath)) {
      return null;
    }
    const creds = readCredentialsFile(credPath);
    if (!creds) {
      return null;
    }
    let refreshToken = creds?.claudeAiOauth?.refreshToken ?? '';
    let accessToken = creds?.claudeAiOauth?.accessToken ?? '';
    const expiresAt = creds?.claudeAiOauth?.expiresAt ?? 0;

    // 如果存储的 accessToken 已过期，检查是否是当前激活账户
    // Claude Code 会自动刷新活跃账户的 token，但不会同步回账户目录
    if (shouldRefreshToken(expiresAt) && fs.existsSync(CLAUDE_CREDS)) {
      try {
        if (config.currentAccount === accountName) {
          // 当前激活账户：直接使用活跃凭证（Claude Code 保持其最新）
          const activeCreds = readCredentialsFile(CLAUDE_CREDS);
          const activeAccess = activeCreds?.claudeAiOauth?.accessToken;
          const activeRefresh = activeCreds?.claudeAiOauth?.refreshToken;
          if (activeAccess) {
            accessToken = activeAccess;
            if (activeRefresh) { refreshToken = activeRefresh; }
          }
        }
      } catch {}
    }

    const plan = creds?.claudeAiOauth?.subscriptionType ?? 'unknown';
    const billingType = creds?.claudeAiOauth?.billingType ?? '';
    const subscriptionCreatedAt = creds?.claudeAiOauth?.subscriptionCreatedAt ?? '';

    let email = '';
    let displayName = '';
    let organization = '';
    const claudeJsonPath = getAccountClaudeJsonPath(accountName);
    if (fs.existsSync(claudeJsonPath)) {
      const claudeJson = JSON.parse(
        fs.readFileSync(claudeJsonPath, 'utf-8')
      ) as ClaudeJson;
      email = claudeJson?.oauthAccount?.emailAddress ?? '';
      displayName = claudeJson?.oauthAccount?.displayName ?? '';
      organization = claudeJson?.oauthAccount?.organizationName ?? '';
    }
    if (!organization && creds?.claudeAiOauth?.rateLimitTier) {
      organization = creds.claudeAiOauth.rateLimitTier;
    }

    return { email, displayName, organization, plan, billingType, subscriptionCreatedAt, refreshToken, accessToken };
  } catch {
    return null;
  }
}

// ─── Token 刷新 ───────────────────────────────────────────────────────────────

async function refreshOAuthToken(accountName: string): Promise<string | null> {
  try {
    const config = loadConfig();
    if (config.currentAccount === accountName && !config.currentApiProvider) {
      syncActiveCredentialsToCurrentAccount(config);
    }

    const credPath = getAccountCredPath(accountName);
    if (!fs.existsSync(credPath)) { return null; }
    const creds = readCredentialsFile(credPath);
    if (!creds) { return null; }
    const refreshToken = creds?.claudeAiOauth?.refreshToken;
    if (!refreshToken) { return null; }

    const activeRefresh = config.currentAccount === accountName && !config.currentApiProvider
      ? readCredentialsFile(CLAUDE_CREDS)?.claudeAiOauth?.refreshToken
      : undefined;
    const refreshTokens = Array.from(new Set([refreshToken, activeRefresh].filter(Boolean) as string[]));

    let lastError = '';
    for (const token of refreshTokens) {
      const key = tokenRefreshKey(token);
      const blockedUntil = tokenRefreshBlockedUntilByKey.get(key);
      if (blockedUntil && blockedUntil > Date.now()) {
        lastError = `Token 刷新冷却，${formatCooldown(blockedUntil - Date.now())}`;
        continue;
      }
      if (blockedUntil && blockedUntil <= Date.now()) {
        tokenRefreshBlockedUntilByKey.delete(key);
      }

      let refreshPromise = tokenRefreshByKey.get(key);
      if (!refreshPromise) {
        refreshPromise = refreshOAuthTokenWithRefreshToken(token).finally(() => {
          tokenRefreshByKey.delete(key);
        });
        tokenRefreshByKey.set(key, refreshPromise);
      }

      const refreshed = await refreshPromise;
      if (refreshed?.accessToken) {
        persistRefreshedOAuthToken(accountName, refreshed);
        return refreshed.accessToken;
      }
      lastError = tokenRefreshErrorByKey.get(key) ?? 'Token 刷新失败';
    }

    usageErrorByAccount.set(accountName, lastError || 'Token 刷新失败');
    return null;
  } catch {
    return null;
  }
}

async function refreshOAuthTokenWithRefreshToken(refreshToken: string): Promise<OAuthTokenRefreshResult | null> {
  const key = tokenRefreshKey(refreshToken);
  const blockedUntil = tokenRefreshBlockedUntilByKey.get(key);
  if (blockedUntil && blockedUntil > Date.now()) {
    tokenRefreshErrorByKey.set(key, `Token 刷新冷却，${formatCooldown(blockedUntil - Date.now())}`);
    return null;
  }

  let lastStatus: number | undefined;
  try {
    for (const tokenUrl of OAUTH_TOKEN_URLS) {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'claude-code/2.1.86',
        },
        body: JSON.stringify({
          client_id: OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      lastStatus = res.status;
      if (res.status === 429) {
        const cooldownMs = clampTokenRefreshCooldown(
          parseRetryAfterMs(res.headers.get('retry-after')) ??
          parseRetryAfterMsHeader(res.headers.get('retry-after-ms'))
        );
        tokenRefreshBlockedUntilByKey.set(key, Date.now() + cooldownMs);
        tokenRefreshErrorByKey.set(key, `Token 刷新 HTTP 429，${formatCooldown(cooldownMs)}`);
        return null;
      }
      if (!res.ok) { continue; }
      const json = await res.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (json.access_token) {
        tokenRefreshBlockedUntilByKey.delete(key);
        tokenRefreshErrorByKey.delete(key);
        return {
          accessToken: json.access_token,
          refreshToken: json.refresh_token,
          expiresIn: json.expires_in,
          tokenUsed: refreshToken,
        };
      }
    }
    tokenRefreshErrorByKey.set(key, lastStatus ? `Token 刷新失败 HTTP ${lastStatus}` : 'Token 刷新失败');
    return null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    tokenRefreshErrorByKey.set(key, message || 'Token 刷新失败');
    return null;
  }
}

function persistRefreshedOAuthToken(accountName: string, refreshed: OAuthTokenRefreshResult): void {
  try {
    const config = loadConfig();
    const credPath = getAccountCredPath(accountName);
    const creds = readCredentialsFile(credPath);
    if (!creds?.claudeAiOauth) { return; }

    const updated: Credentials = {
      claudeAiOauth: {
        ...creds.claudeAiOauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || refreshed.tokenUsed,
        expiresAt: refreshed.expiresIn ? Date.now() + refreshed.expiresIn * 1000 : undefined,
      },
    };
    writeJsonFileAtomic(credPath, updated);

    // 如果是当前激活账户，同步更新 ~/.claude/.credentials.json
    if (config.currentAccount === accountName && !config.currentApiProvider) {
      const active = readCredentialsFile(CLAUDE_CREDS) ?? {};
      active.claudeAiOauth = updated.claudeAiOauth;
      writeJsonFileAtomic(CLAUDE_CREDS, active);
    }
  } catch {}
}

// ─── 使用量 API ───────────────────────────────────────────────────────────────

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) { return undefined; }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = new Date(value).getTime();
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function parseRetryAfterMsHeader(value: string | null): number | undefined {
  if (!value) { return undefined; }
  const ms = Number(value);
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

function formatCooldown(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `${minutes}分钟后重试`;
}

async function fetchUsage(accessToken: string): Promise<{ data: UsageData | null; error?: string; status?: number; retryAfterMs?: number }> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) {
      return {
        data: null,
        error: `HTTP ${res.status}`,
        status: res.status,
        retryAfterMs: res.status === 429
          ? parseRetryAfterMs(res.headers.get('retry-after')) ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS
          : undefined,
      };
    }
    return { data: (await res.json()) as UsageData };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, error: message };
  }
}

async function fetchOAuthProfile(accessToken: string): Promise<OAuthProfile | null> {
  try {
    const res = await fetch(OAUTH_PROFILE_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as OAuthProfile;
  } catch {
    return null;
  }
}

function profileToClaudeJson(profile: OAuthProfile): ClaudeJson {
  return {
    oauthAccount: {
      emailAddress: profile.account?.email ?? '',
      displayName: profile.account?.display_name ?? profile.account?.full_name ?? '',
      organizationName: profile.organization?.name ?? '',
    },
  };
}

function getPlanFromProfile(profile: OAuthProfile): string {
  if (profile.account?.has_claude_max) { return 'max'; }
  if (profile.account?.has_claude_pro) { return 'pro'; }
  return profile.organization?.organization_type ?? '';
}

function updateCredentialsPlanFromProfile(credPath: string, profile: OAuthProfile): void {
  const plan = getPlanFromProfile(profile);
  const tier = profile.organization?.rate_limit_tier;
  const billingType = profile.organization?.billing_type;
  const subscriptionCreatedAt = profile.organization?.subscription_created_at;
  if (!plan && !tier && !billingType && !subscriptionCreatedAt) { return; }
  try {
    const creds = readCredentialsFile(credPath);
    if (!creds?.claudeAiOauth) { return; }
    if (plan) {
      creds.claudeAiOauth.subscriptionType = plan;
    }
    if (tier) {
      creds.claudeAiOauth.rateLimitTier = tier;
    }
    if (billingType) {
      creds.claudeAiOauth.billingType = billingType;
    }
    if (subscriptionCreatedAt) {
      creds.claudeAiOauth.subscriptionCreatedAt = subscriptionCreatedAt;
    }
    creds.claudeAiOauth.profileFetchedAt = Date.now();
    writeJsonFileAtomic(credPath, creds);
  } catch {}
}

async function refreshAccountProfileMetadata(accountName: string, force = false): Promise<void> {
  try {
    const credPath = getAccountCredPath(accountName);
    const claudeJsonPath = getAccountClaudeJsonPath(accountName);
    const creds = readCredentialsFile(credPath);
    if (!creds?.claudeAiOauth) { return; }

    const fetchedAt = creds.claudeAiOauth.profileFetchedAt ?? 0;
    if (!force && fetchedAt && Date.now() - fetchedAt < PROFILE_CACHE_TTL_MS) {
      return;
    }

    let accessToken = creds.claudeAiOauth.accessToken;
    if (shouldRefreshToken(creds.claudeAiOauth.expiresAt)) {
      accessToken = await refreshOAuthToken(accountName) ?? undefined;
    }
    if (!accessToken) { return; }

    const profile = await fetchOAuthProfile(accessToken);
    if (!profile) { return; }
    writeJsonFileAtomic(claudeJsonPath, profileToClaudeJson(profile));
    updateCredentialsPlanFromProfile(credPath, profile);
  } catch {}
}

async function cacheProfileForCredentials(credPath: string, claudeJsonPath: string): Promise<OAuthProfile | null> {
  try {
    const creds = readCredentialsFile(credPath);
    const accessToken = creds?.claudeAiOauth?.accessToken;
    if (!accessToken) { return null; }
    const profile = await fetchOAuthProfile(accessToken);
    if (!profile) { return null; }
    writeJsonFileAtomic(claudeJsonPath, profileToClaudeJson(profile));
    updateCredentialsPlanFromProfile(credPath, profile);
    return profile;
  } catch {
    return null;
  }
}

async function getUsage(accountName: string, force = false): Promise<UsageData | null> {
  const config = loadConfig();
  const currentAccount = detectCurrentAccount(config);
  const isCurrentAccount = accountName === currentAccount && !config.currentApiProvider;
  const cached = getStoredUsageCache(accountName);

  if (!isCurrentAccount && !force) {
    if (cached && !shouldRefreshCachedQuota(cached)) {
      usageErrorByAccount.delete(accountName);
      return cached.data;
    }
  }

  if (force) {
    usageRetryAfterByAccount.delete(accountName);
  }

  if (cached && !force && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.data;
  }

  const retryAfter = usageRetryAfterByAccount.get(accountName);
  if (retryAfter && retryAfter > Date.now()) {
    usageErrorByAccount.set(accountName, `HTTP 429，${formatCooldown(retryAfter - Date.now())}`);
    return cached?.data ?? null;
  }
  if (retryAfter && retryAfter <= Date.now()) {
    usageRetryAfterByAccount.delete(accountName);
  }

  const info = readAccountInfo(accountName);
  if (!info?.accessToken) {
    usageErrorByAccount.set(accountName, '缺少 access token');
    return null;
  }

  // 检查 token 是否过期，过期则尝试刷新
  const credPath = getAccountCredPath(accountName);
  let accessToken = info.accessToken;
  let tokenRefreshFailed = false;
  let refreshedBeforeUsage = false;
  try {
    const creds = readCredentialsFile(credPath);
    const expiresAt = creds?.claudeAiOauth?.expiresAt ?? 0;
    const nonCurrentNeedsQuotaRefresh = !isCurrentAccount && (!cached || shouldRefreshCachedQuota(cached));
    if (nonCurrentNeedsQuotaRefresh || (!isCurrentAccount && force) || shouldRefreshToken(expiresAt)) {
      const newToken = await refreshOAuthToken(accountName);
      if (newToken) {
        accessToken = newToken;
        refreshedBeforeUsage = true;
      } else {
        tokenRefreshFailed = true;
      }
    }
  } catch {}

  if (tokenRefreshFailed) {
    const tokenError = usageErrorByAccount.get(accountName) ?? 'Token 刷新失败';
    usageErrorByAccount.set(accountName, `${tokenError}，请切换到该账号后刷新`);
    return cached?.data ?? null;
  }

  let { data, error, status, retryAfterMs } = await fetchUsage(accessToken);
  if (
    data &&
    !isCurrentAccount &&
    !refreshedBeforeUsage &&
    isEmptyQuotaWindow(data)
  ) {
    const refreshedToken = await refreshOAuthToken(accountName);
    if (refreshedToken) {
      refreshedBeforeUsage = true;
      ({ data, error, status, retryAfterMs } = await fetchUsage(refreshedToken));
    }
  }
  if (!data && (status === 401 || status === 403)) {
    const refreshedToken = await refreshOAuthToken(accountName);
    if (refreshedToken) {
      ({ data, error, status, retryAfterMs } = await fetchUsage(refreshedToken));
    } else {
      error = `${error ?? `HTTP ${status}`}，Token 刷新失败`;
    }
  }
  if (data && !isCurrentAccount && isEmptyQuotaWindow(data)) {
    if (cached) {
      usageErrorByAccount.set(accountName, '官方未返回额度窗口，保留上次成功缓存');
      return cached.data;
    }
    usageErrorByAccount.set(accountName, '官方未返回额度窗口，暂无可信缓存');
    return null;
  }
  if (data) {
    setStoredUsageCache(accountName, data);
    usageErrorByAccount.delete(accountName);
    usageRetryAfterByAccount.delete(accountName);
  } else {
    if (retryAfterMs) {
      usageRetryAfterByAccount.set(accountName, Date.now() + retryAfterMs);
    }
    usageErrorByAccount.set(
      accountName,
      retryAfterMs ? `${error ?? '读取失败'}，${formatCooldown(retryAfterMs)}` : error ?? '读取失败'
    );
  }
  return data ?? cached?.data ?? null;
}

// ─── 自动生成账户名 ───────────────────────────────────────────────────────────

function generateAccountName(email: string, existingAccounts: Account[]): string {
  const domain = email.split('@')[1] ?? 'account';
  const domainBase = domain.split('.')[0];
  const index = (existingAccounts.length + 1).toString().padStart(2, '0');
  return `${domainBase}_${index}`;
}

// ─── 账户识别 ─────────────────────────────────────────────────────────────────

function detectCurrentAccount(config: Config): string | undefined {
  if (config.currentAccount) {
    return config.currentAccount;
  }
  if (!fs.existsSync(CLAUDE_CREDS)) {
    return undefined;
  }
  try {
    const active = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf-8')) as Credentials;
    const activeToken = active?.claudeAiOauth?.refreshToken;
    if (!activeToken) {
      return undefined;
    }
    for (const account of config.accounts) {
      const credPath = getAccountCredPath(account.name);
      if (!fs.existsSync(credPath)) {
        continue;
      }
      try {
        const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as Credentials;
        if (creds?.claudeAiOauth?.refreshToken === activeToken) {
          return account.name;
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

// ─── 账户切换 ─────────────────────────────────────────────────────────────────

async function switchToAccount(name: string): Promise<void> {
  const credPath = getAccountCredPath(name);
  if (!fs.existsSync(credPath)) {
    throw new Error(`账户 "${name}" 的凭证文件不存在，请重新添加该账户`);
  }

  // 切换前把当前活跃凭证同步回当前账户目录
  // 确保存储的 token 是 Claude Code 最新刷新过的版本
  const config = loadConfig();
  if (config.currentAccount && !config.currentApiProvider) {
    const currentCredPath = getAccountCredPath(config.currentAccount);
    if (fs.existsSync(CLAUDE_CREDS) && fs.existsSync(currentCredPath)) {
      try { fs.copyFileSync(CLAUDE_CREDS, currentCredPath); } catch {}
    }
  }

  // 如果目标账户的 accessToken 已过期，先用 refreshToken 刷新
  // 这样复制到活跃位置时 Claude Code 能直接使用，无需重新登录
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as Credentials;
    if (shouldRefreshToken(creds?.claudeAiOauth?.expiresAt)) {
      await refreshOAuthToken(name);
    }
  } catch {}

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.copyFileSync(credPath, CLAUDE_CREDS); // 此时已是最新 token

  // 同时替换 .claude.json，防止身份标识与 token 不一致导致登录记录丢失
  const srcClaudeJson = getAccountClaudeJsonPath(name);
  const dstClaudeJson = path.join(CLAUDE_DIR, '.claude.json');
  if (fs.existsSync(srcClaudeJson)) {
    try { fs.copyFileSync(srcClaudeJson, dstClaudeJson); } catch {}
  }

  config.currentAccount = name;
  config.currentApiProvider = undefined; // 清除 API Provider 模式
  appendUsageAttribution(config, 'account', name);
  saveConfig(config);
  clearApiProviderSettings();
}

// ─── API Provider 切换 ─────────────────────────────────────────────────────────

function switchToApiProvider(name: string): void {
  const config = loadConfig();
  const provider = config.apiProviders?.find((p) => p.name === name);
  if (!provider) {
    throw new Error(`API Provider "${name}" 不存在`);
  }

  // 写入 settings.json
  const settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    try {
      Object.assign(settings, JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8')));
    } catch {}
  }
  settings.env = settings.env || {};
  // __cas 标记表示此 env 块由本扩展写入，避免误清除 cc-switch 等工具的配置
  (settings.env as Record<string, string>).__cas = '1';
  (settings.env as Record<string, string>).ANTHROPIC_API_KEY = provider.apiKey;
  (settings.env as Record<string, string>).ANTHROPIC_BASE_URL = provider.baseUrl;

  // GLM-5.1 风格：使用 DEFAULT_*_MODEL 环境变量
  if (provider.model) {
    // 如果 model 包含 GLM，则设置三个默认模型变量
    if (provider.model.toUpperCase().includes('GLM')) {
      (settings.env as Record<string, string>).ANTHROPIC_DEFAULT_OPUS_MODEL = provider.model;
      (settings.env as Record<string, string>).ANTHROPIC_DEFAULT_SONNET_MODEL = provider.model;
      // Haiku 用轻量模型
      (settings.env as Record<string, string>).ANTHROPIC_DEFAULT_HAIKU_MODEL = 'GLM-4.5-air';
    } else {
      // 非 GLM 模型，使用单一 MODEL 变量
      (settings.env as Record<string, string>).ANTHROPIC_MODEL = provider.model;
    }
  }

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8');

  config.currentApiProvider = name;
  config.currentAccount = undefined; // 清除 OAuth 账户模式
  appendUsageAttribution(config, 'api', name);
  saveConfig(config);
}

function clearApiProviderSettings(): void {
  if (!fs.existsSync(CLAUDE_SETTINGS)) {return;}
  try {
    const settings: Record<string, unknown> = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8'));
    if (settings.env) {
      const env = settings.env as Record<string, unknown>;
      // 只清除由本扩展写入的配置（__cas 标记），避免误删 cc-switch 等工具的配置
      if (!env.__cas) { return; }
      const keysToClean = [
        '__cas',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      ];
      for (const key of keysToClean) {
        delete env[key];
      }
      // 如果 env 为空对象，整个删除
      if (Object.keys(env).length === 0) {
        delete settings.env;
      }
      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8');
    }
  } catch {}
}

// ─── 重置时间格式化 ───────────────────────────────────────────────────────────

function formatResetTime(resetsAt: string | undefined): string {
  if (!resetsAt) {return '';}
  const diffMs = new Date(resetsAt).getTime() - Date.now();
  if (diffMs <= 0) {return '已重置';}
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  if (h >= 1) {return `${h}小时${m > 0 ? m + '分' : ''}后重置`;}
  return `${m}分钟后重置`;
}

function formatQuotaTiming(window: UsageWindow, cache?: StoredUsageCache, isCurrentAccount = false): {
  description: string;
  tooltip: string;
  tooltipPrefix: string;
} {
  const reset = formatResetTime(window.resets_at);
  if (reset) {
    return {
      description: `重置 ${reset}`,
      tooltip: `重置: ${reset}`,
      tooltipPrefix: reset,
    };
  }

  if (cache && !isCurrentAccount) {
    const nextRefresh = formatUsageCacheTime(getNextQuotaRefreshAt(cache));
    return {
      description: `下次刷新 ${nextRefresh}`,
      tooltip: `官方未返回重置时间\n缓存下次刷新: ${nextRefresh}`,
      tooltipPrefix: `下次刷新 ${nextRefresh}`,
    };
  }

  return {
    description: '',
    tooltip: '重置时间未知',
    tooltipPrefix: '重置时间未知',
  };
}

// ─── 使用量百分比格式化 ───────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function usageColor(n: number): string {
  if (n >= 80) {return '#f44336';}
  if (n >= 50) {return '#ff9800';}
  return '#4caf50';
}

// ─── 本地 Token/成本统计 ─────────────────────────────────────────────────────

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, requests: 0 };
}

function cloneTotals(value: TokenTotals): TokenTotals {
  return {
    input: value.input,
    output: value.output,
    cacheCreate: value.cacheCreate,
    cacheRead: value.cacheRead,
    cost: value.cost,
    requests: value.requests,
  };
}

function addTotals(target: TokenTotals, delta: TokenTotals): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheCreate += delta.cacheCreate;
  target.cacheRead += delta.cacheRead;
  target.cost += delta.cost;
  target.requests += delta.requests;
}

function getPricingForModel(model: string): ModelPricing | null {
  for (const item of MODEL_PRICING) {
    if (item.match.test(model)) {
      return item.pricing;
    }
  }
  return null;
}

function calculateCost(model: string, input: number, output: number, cacheCreate: number, cacheRead: number): number {
  const pricing = getPricingForModel(model);
  if (!pricing) { return 0; }
  return (
    input * pricing.input +
    output * pricing.output +
    cacheCreate * pricing.cacheCreate +
    cacheRead * pricing.cacheRead
  ) / 1_000_000;
}

function formatCompactNumber(n: number): string {
  return Math.round(n).toLocaleString();
}

function formatTokenShort(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`; }
  return Math.round(n).toString();
}

function formatUsd(n: number): string {
  if (n === 0) { return '$0.00'; }
  if (n < 0.01) { return `<$0.01`; }
  return `$${n.toFixed(2)}`;
}

function totalTokens(value: TokenTotals | undefined): number {
  if (!value) { return 0; }
  return value.input + value.output + value.cacheCreate + value.cacheRead;
}

function getJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) { return files; }

  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  };

  walk(dir);
  return files;
}

function getEntryDate(timestamp: string | undefined): string {
  const d = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return formatLocalDate(d);
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLocalTokenStats(force = false): LocalTokenStats {
  if (!force && localStatsCache && Date.now() - localStatsCache.fetchedAt < CACHE_TTL) {
    return localStatsCache.data;
  }

  const totals = emptyTotals();
  const byKind: Record<UsageSourceType, TokenTotals> = {
    account: emptyTotals(),
    api: emptyTotals(),
    unknown: emptyTotals(),
  };
  const bySource = new Map<string, SourceTokenStats>();
  const bySourceDay = new Map<string, SourceDailyTokenStats>();
  const bySourceDayModel = new Map<string, SourceDayModelTokenStats>();
  const byModel = new Map<string, TokenTotals>();
  const byDayModel = new Map<string, DayModelTokenStats>();
  const byDay = new Map<string, TokenTotals>();
  const files = getJsonlFiles(CLAUDE_PROJECTS_DIR);
  const attributionHistory = getSortedAttributionHistory(loadConfig());
  let recordsScanned = 0;

  for (const file of files) {
    let lines: string[];
    try {
      lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    } catch {
      continue;
    }

    for (const line of lines) {
      if (!line.trim()) { continue; }
      let entry: ClaudeTranscriptEntry;
      try {
        entry = JSON.parse(line) as ClaudeTranscriptEntry;
      } catch {
        continue;
      }

      const usage = entry.message?.usage;
      if (entry.type !== 'assistant' || entry.message?.role !== 'assistant' || !usage) {
        continue;
      }

      const model = entry.message.model ?? 'unknown';
      const input = Number(usage.input_tokens ?? 0);
      const output = Number(usage.output_tokens ?? 0);
      const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
      const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
      if (input + output + cacheCreate + cacheRead === 0) {
        continue;
      }

      recordsScanned++;
      const delta: TokenTotals = {
        input,
        output,
        cacheCreate,
        cacheRead,
        cost: calculateCost(model, input, output, cacheCreate, cacheRead),
        requests: 1,
      };

      addTotals(totals, delta);
      const timestampMs = entry.timestamp ? new Date(entry.timestamp).getTime() : Number.NaN;
      const source = resolveUsageSourceAt(timestampMs, attributionHistory);
      addTotals(byKind[source.sourceType], delta);

      const srcKey = sourceKey(source.sourceType, source.sourceName);
      const sourceTotals = bySource.get(srcKey) ?? {
        sourceType: source.sourceType,
        sourceName: source.sourceName,
        sourceLabel: source.sourceLabel,
        ...emptyTotals(),
      };
      addTotals(sourceTotals, delta);
      bySource.set(srcKey, sourceTotals);

      const modelTotals = byModel.get(model) ?? emptyTotals();
      addTotals(modelTotals, delta);
      byModel.set(model, modelTotals);

      const day = getEntryDate(entry.timestamp);
      const dayTotals = byDay.get(day) ?? emptyTotals();
      addTotals(dayTotals, delta);
      byDay.set(day, dayTotals);

      const dayModelKey = `${day}:${model}`;
      const dayModelTotals = byDayModel.get(dayModelKey) ?? {
        date: day,
        model,
        ...emptyTotals(),
      };
      addTotals(dayModelTotals, delta);
      byDayModel.set(dayModelKey, dayModelTotals);

      const srcDayKey = `${srcKey}:${day}`;
      const sourceDayTotals = bySourceDay.get(srcDayKey) ?? {
        sourceType: source.sourceType,
        sourceName: source.sourceName,
        sourceLabel: source.sourceLabel,
        date: day,
        ...emptyTotals(),
      };
      addTotals(sourceDayTotals, delta);
      bySourceDay.set(srcDayKey, sourceDayTotals);

      const srcDayModelKey = `${srcKey}:${day}:${model}`;
      const sourceDayModelTotals = bySourceDayModel.get(srcDayModelKey) ?? {
        sourceType: source.sourceType,
        sourceName: source.sourceName,
        sourceLabel: source.sourceLabel,
        date: day,
        model,
        ...emptyTotals(),
      };
      addTotals(sourceDayModelTotals, delta);
      bySourceDayModel.set(srcDayModelKey, sourceDayModelTotals);
    }
  }

  const data: LocalTokenStats = {
    totals,
    byKind,
    bySource: Array.from(bySource.values())
      .sort((a, b) => b.cost - a.cost || totalTokens(b) - totalTokens(a)),
    bySourceDay: Array.from(bySourceDay.values())
      .sort((a, b) => b.date.localeCompare(a.date) || a.sourceLabel.localeCompare(b.sourceLabel)),
    bySourceDayModel: Array.from(bySourceDayModel.values())
      .sort((a, b) => b.date.localeCompare(a.date) || a.sourceLabel.localeCompare(b.sourceLabel) || b.cost - a.cost || b.output - a.output),
    byModel: Array.from(byModel.entries())
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => b.cost - a.cost || b.output - a.output),
    byDayModel: Array.from(byDayModel.values())
      .sort((a, b) => b.date.localeCompare(a.date) || b.cost - a.cost || b.output - a.output),
    byDay: Array.from(byDay.entries())
      .map(([date, value]) => ({ date, ...value }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    filesScanned: files.length,
    recordsScanned,
    updatedAt: Date.now(),
  };

  localStatsCache = { data, fetchedAt: Date.now() };
  return data;
}

function getRecentStatsStartDate(days: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - Math.max(0, days - 1));
  return formatLocalDate(start);
}

function buildStatsFromSourceDayModels(rows: SourceDayModelTokenStats[], baseStats: LocalTokenStats): LocalTokenStats {
  const totals = emptyTotals();
  const byKind: Record<UsageSourceType, TokenTotals> = {
    account: emptyTotals(),
    api: emptyTotals(),
    unknown: emptyTotals(),
  };
  const bySource = new Map<string, SourceTokenStats>();
  const bySourceDay = new Map<string, SourceDailyTokenStats>();
  const bySourceDayModel = new Map<string, SourceDayModelTokenStats>();
  const byModel = new Map<string, TokenTotals>();
  const byDayModel = new Map<string, DayModelTokenStats>();
  const byDay = new Map<string, TokenTotals>();

  for (const row of rows) {
    const delta: TokenTotals = {
      input: row.input,
      output: row.output,
      cacheCreate: row.cacheCreate,
      cacheRead: row.cacheRead,
      cost: row.cost,
      requests: row.requests,
    };
    addTotals(totals, delta);
    addTotals(byKind[row.sourceType], delta);

    const srcKey = sourceKey(row.sourceType, row.sourceName);
    const sourceTotals = bySource.get(srcKey) ?? {
      sourceType: row.sourceType,
      sourceName: row.sourceName,
      sourceLabel: row.sourceLabel,
      ...emptyTotals(),
    };
    addTotals(sourceTotals, delta);
    bySource.set(srcKey, sourceTotals);

    const srcDayKey = `${srcKey}:${row.date}`;
    const sourceDayTotals = bySourceDay.get(srcDayKey) ?? {
      sourceType: row.sourceType,
      sourceName: row.sourceName,
      sourceLabel: row.sourceLabel,
      date: row.date,
      ...emptyTotals(),
    };
    addTotals(sourceDayTotals, delta);
    bySourceDay.set(srcDayKey, sourceDayTotals);

    const srcDayModelKey = `${srcKey}:${row.date}:${row.model}`;
    const sourceDayModelTotals = bySourceDayModel.get(srcDayModelKey) ?? {
      sourceType: row.sourceType,
      sourceName: row.sourceName,
      sourceLabel: row.sourceLabel,
      date: row.date,
      model: row.model,
      ...emptyTotals(),
    };
    addTotals(sourceDayModelTotals, delta);
    bySourceDayModel.set(srcDayModelKey, sourceDayModelTotals);

    const modelTotals = byModel.get(row.model) ?? emptyTotals();
    addTotals(modelTotals, delta);
    byModel.set(row.model, modelTotals);

    const dayModelKey = `${row.date}:${row.model}`;
    const dayModelTotals = byDayModel.get(dayModelKey) ?? {
      date: row.date,
      model: row.model,
      ...emptyTotals(),
    };
    addTotals(dayModelTotals, delta);
    byDayModel.set(dayModelKey, dayModelTotals);

    const dayTotals = byDay.get(row.date) ?? emptyTotals();
    addTotals(dayTotals, delta);
    byDay.set(row.date, dayTotals);
  }

  return {
    totals,
    byKind,
    bySource: Array.from(bySource.values())
      .sort((a, b) => b.cost - a.cost || totalTokens(b) - totalTokens(a)),
    bySourceDay: Array.from(bySourceDay.values())
      .sort((a, b) => b.date.localeCompare(a.date) || a.sourceLabel.localeCompare(b.sourceLabel)),
    bySourceDayModel: Array.from(bySourceDayModel.values())
      .sort((a, b) => b.date.localeCompare(a.date) || a.sourceLabel.localeCompare(b.sourceLabel) || b.cost - a.cost || b.output - a.output),
    byModel: Array.from(byModel.entries())
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => b.cost - a.cost || b.output - a.output),
    byDayModel: Array.from(byDayModel.values())
      .sort((a, b) => b.date.localeCompare(a.date) || b.cost - a.cost || b.output - a.output),
    byDay: Array.from(byDay.entries())
      .map(([date, value]) => ({ date, ...value }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    filesScanned: baseStats.filesScanned,
    recordsScanned: rows.reduce((sum, row) => sum + row.requests, 0),
    updatedAt: baseStats.updatedAt,
  };
}

function filterLocalTokenStatsByRecentDays(stats: LocalTokenStats, days: number): LocalTokenStats {
  const startDate = getRecentStatsStartDate(days);
  return buildStatsFromSourceDayModels(
    stats.bySourceDayModel.filter((row) => row.date >= startDate),
    stats
  );
}

function buildSourceModelStats(stats: LocalTokenStats): SourceModelTokenStats[] {
  const bySourceModel = new Map<string, SourceModelTokenStats>();
  for (const row of stats.bySourceDayModel) {
    const srcKey = sourceKey(row.sourceType, row.sourceName);
    const key = `${srcKey}:${row.model}`;
    const totals = bySourceModel.get(key) ?? {
      sourceType: row.sourceType,
      sourceName: row.sourceName,
      sourceLabel: row.sourceLabel,
      model: row.model,
      ...emptyTotals(),
    };
    addTotals(totals, row);
    bySourceModel.set(key, totals);
  }
  return Array.from(bySourceModel.values())
    .sort((a, b) =>
      a.sourceLabel.localeCompare(b.sourceLabel) ||
      totalTokens(b) - totalTokens(a) ||
      b.cost - a.cost
    );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSourceDayTotals(stats: LocalTokenStats, sourceType: UsageSourceType, sourceName: string, date: string): SourceDailyTokenStats | undefined {
  return stats.bySourceDay.find((row) =>
    row.sourceType === sourceType &&
    row.sourceName === sourceName &&
    row.date === date
  );
}

function getSourceDayTopModel(stats: LocalTokenStats, sourceType: UsageSourceType, sourceName: string, date: string): SourceDayModelTokenStats | undefined {
  return stats.bySourceDayModel
    .filter((row) =>
      row.sourceType === sourceType &&
      row.sourceName === sourceName &&
      row.date === date
    )
    .sort((a, b) => b.cost - a.cost || b.output - a.output)[0];
}

function formatTotalsInline(value: TokenTotals | undefined): string {
  const tokens = totalTokens(value);
  return `${formatTokenShort(tokens)} tok · ${formatUsd(value?.cost ?? 0)}`;
}

function buildTotalsCells(value: TokenTotals): string {
  return [
    `<td>${formatCompactNumber(value.input)}</td>`,
    `<td>${formatCompactNumber(value.output)}</td>`,
    `<td>${formatCompactNumber(value.cacheCreate)}</td>`,
    `<td>${formatCompactNumber(value.cacheRead)}</td>`,
    `<td>${formatCompactNumber(value.requests)}</td>`,
    `<td>${formatUsd(value.cost)}</td>`,
  ].join('');
}

function buildShareCell(share: number): string {
  const width = Math.max(2, Math.min(100, share));
  return `<td>
    <div class="share-cell">
      <div class="share-track"><div class="share-fill" style="width:${width.toFixed(1)}%"></div></div>
      <span>${share.toFixed(1)}%</span>
    </div>
  </td>`;
}

function buildHeatmapHtml(stats: LocalTokenStats, days = 182): string {
  const today = new Date();
  const values = new Map(stats.byDay.map((row) => [row.date, totalTokens(row)]));
  const max = Math.max(1, ...Array.from(values.values()));
  const cells: string[] = [];
  const start = new Date(today);
  start.setDate(today.getDate() - (days - 1));
  const startWeekday = start.getDay();
  const columns = Math.ceil((days + startWeekday) / 7);

  for (let index = 0; index < days; index++) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = formatLocalDate(date);
    const value = values.get(key) ?? 0;
    const level = value === 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((value / max) * 4)));
    const rowIndex = date.getDay() + 1;
    const columnIndex = Math.floor((startWeekday + index) / 7) + 1;
    const row = stats.byDay.find((item) => item.date === key);
    const tooltip = row
      ? `${key}\nToken: ${formatCompactNumber(value)}\n输入: ${formatCompactNumber(row.input)}\n输出: ${formatCompactNumber(row.output)}\n缓存写入: ${formatCompactNumber(row.cacheCreate)}\n缓存读取: ${formatCompactNumber(row.cacheRead)}\n费用: ${formatUsd(row.cost)}`
      : `${key}\n无用量`;
    cells.push(`<div class="heat-cell heat-${level}" style="grid-row:${rowIndex};grid-column:${columnIndex}" title="${escapeHtml(tooltip)}"></div>`);
  }

  return `<div class="heat-axis-x">横轴：日期，从左到右接近今天</div>
  <div class="heat-layout">
    <div class="heat-axis-y">
      <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
    </div>
    <div class="heatmap-wrap">
      <div class="heatmap" style="grid-template-columns: repeat(${columns}, 16px)">${cells.join('')}</div>
    </div>
  </div>
  <div class="heat-footer">
    <span>纵轴：星期</span>
    <span class="heat-legend"><span>少</span><span class="heat-cell heat-1"></span><span class="heat-cell heat-2"></span><span class="heat-cell heat-3"></span><span class="heat-cell heat-4"></span><span>多</span></span>
  </div>`;
}

function buildSourceModelRows(stats: LocalTokenStats, limit = 80): string {
  const sourceTotals = new Map(stats.bySource.map((row) => [sourceKey(row.sourceType, row.sourceName), totalTokens(row)]));
  return buildSourceModelStats(stats).slice(0, limit).map((row) => {
    const srcKey = sourceKey(row.sourceType, row.sourceName);
    const sourceTotal = sourceTotals.get(srcKey) ?? 0;
    const share = sourceTotal > 0 ? (totalTokens(row) / sourceTotal) * 100 : 0;
    return `
      <tr>
        <td>${escapeHtml(row.sourceLabel)}</td>
        <td class="mono">${escapeHtml(row.model)}</td>
        ${buildShareCell(share)}
        ${buildTotalsCells(row)}
      </tr>
    `;
  }).join('');
}

function buildDailyCombinedRows(stats: LocalTokenStats, limit = 45): string {
  return stats.byDay.slice(0, limit).map((day) => {
    const sources = stats.bySourceDay
      .filter((row) => row.date === day.date)
      .sort((a, b) => {
        const order = { account: 0, api: 1, unknown: 2 } as Record<UsageSourceType, number>;
        return order[a.sourceType] - order[b.sourceType] || b.cost - a.cost;
      });
    const sourceRows = sources.map((row) => `
      <tr class="source-day-row">
        <td></td>
        <td>${escapeHtml(row.sourceLabel)}</td>
        ${buildTotalsCells(row)}
      </tr>
    `).join('');
    return `
      <tr class="daily-total-row">
        <td>${day.date}</td>
        <td>全部</td>
        ${buildTotalsCells(day)}
      </tr>
      ${sourceRows}
    `;
  }).join('');
}

// ─── Webview 使用量面板 ───────────────────────────────────────────────────────

function buildUsageHtml(
  accounts: { name: string; info: AccountInfo | null; usage: UsageData | null }[],
  localStats?: LocalTokenStats
): string {
  const visibleStats = localStats ? filterLocalTokenStatsByRecentDays(localStats, DEFAULT_USAGE_STATS_DAYS) : undefined;
  const recentStartDate = getRecentStatsStartDate(DEFAULT_USAGE_STATS_DAYS);
  const tokenSummary = visibleStats ? `
    <section class="summary-grid">
      <div class="metric-card"><div class="metric-label">Token</div><div class="metric-value">${formatCompactNumber(totalTokens(visibleStats.totals))}</div></div>
      <div class="metric-card"><div class="metric-label">估算费用</div><div class="metric-value">${formatUsd(visibleStats.totals.cost)}</div></div>
      <div class="metric-card"><div class="metric-label">账号调用</div><div class="metric-value">${formatTotalsInline(visibleStats.byKind.account)}</div></div>
      <div class="metric-card"><div class="metric-label">API 调用</div><div class="metric-value">${formatTotalsInline(visibleStats.byKind.api)}</div></div>
      <div class="metric-card"><div class="metric-label">未归因</div><div class="metric-value">${formatTotalsInline(visibleStats.byKind.unknown)}</div></div>
      <div class="metric-card"><div class="metric-label">请求数</div><div class="metric-value">${formatCompactNumber(visibleStats.totals.requests)}</div></div>
    </section>
    <div class="stats-meta">默认统计 ${recentStartDate} 至今天；扫描 ${localStats?.filesScanned ?? 0} 个日志文件，${localStats?.recordsScanned ?? 0} 条 assistant usage 记录；更新时间 ${localStats ? new Date(localStats.updatedAt).toLocaleString() : ''}</div>
  ` : `<div class="dim">正在读取本地 Claude Code 用量日志...</div>`;

  const sourceRows = visibleStats?.bySource.map((row) => `
    <tr>
      <td>${escapeHtml(row.sourceLabel)}</td>
      ${buildTotalsCells(row)}
    </tr>
  `).join('') ?? '';

  const sourceModelRows = visibleStats ? buildSourceModelRows(visibleStats) : '';

  const modelRows = visibleStats?.byModel.slice(0, 20).map((row) => `
    <tr>
      <td class="mono">${escapeHtml(row.model)}</td>
      ${buildTotalsCells(row)}
    </tr>
  `).join('') ?? '';

  const dailyCombinedRows = visibleStats ? buildDailyCombinedRows(visibleStats, DEFAULT_USAGE_STATS_DAYS) : '';
  const historicalSourceRows = localStats?.bySource.map((row) => `
    <tr>
      <td>${escapeHtml(row.sourceLabel)}</td>
      ${buildTotalsCells(row)}
    </tr>
  `).join('') ?? '';
  const historicalSourceModelRows = localStats ? buildSourceModelRows(localStats, 160) : '';
  const historicalModelRows = localStats?.byModel.slice(0, 80).map((row) => `
    <tr>
      <td class="mono">${escapeHtml(row.model)}</td>
      ${buildTotalsCells(row)}
    </tr>
  `).join('') ?? '';
  const historicalDailyCombinedRows = localStats ? buildDailyCombinedRows(localStats, HISTORY_DAILY_ROW_LIMIT) : '';

  const topStatsHtml = `
    <section class="section-block">
      <h2>最近 ${DEFAULT_USAGE_STATS_DAYS} 天</h2>
      ${tokenSummary}
      <div class="note">价格按内置公开 API 价格表估算，仅用于比较模型/日期消耗；订阅账号实际额度扣减不等同于 API 账单。</div>
    </section>
    <section class="section-block">
      <h2>使用热力图</h2>
      ${visibleStats ? buildHeatmapHtml(visibleStats, DEFAULT_USAGE_STATS_DAYS) : ''}
    </section>
  `;

  const detailStatsHtml = `
    <section class="section-block">
      <h2>来源累计</h2>
      <table>
        <thead><tr><th>来源</th><th>输入</th><th>输出</th><th>缓存写入</th><th>缓存读取</th><th>请求</th><th>估算费用</th></tr></thead>
        <tbody>${sourceRows || '<tr><td colspan="7" class="dim">暂无来源统计；后续通过 CC Manager 切换后会开始归因</td></tr>'}</tbody>
      </table>
    </section>
    <section class="section-block">
      <h2>来源模型占比</h2>
      <table>
        <thead><tr><th>来源</th><th>模型</th><th>占比</th><th>输入</th><th>输出</th><th>缓存写入</th><th>缓存读取</th><th>请求</th><th>估算费用</th></tr></thead>
        <tbody>${sourceModelRows || '<tr><td colspan="9" class="dim">暂无来源模型统计</td></tr>'}</tbody>
      </table>
    </section>
    <section class="section-block">
      <h2>模型用量</h2>
      <table>
        <thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存写入</th><th>缓存读取</th><th>请求</th><th>估算费用</th></tr></thead>
        <tbody>${modelRows || '<tr><td colspan="7" class="dim">暂无模型用量记录</td></tr>'}</tbody>
      </table>
    </section>
  `;

  const historicalStatsHtml = localStats ? `
    <details class="section-block history-block">
      <summary>历史统计</summary>
      <div class="history-body">
        <section class="section-block">
          <h2>全量热力图</h2>
          ${buildHeatmapHtml(localStats)}
        </section>
        <section class="summary-grid">
          <div class="metric-card"><div class="metric-label">历史 Token</div><div class="metric-value">${formatCompactNumber(totalTokens(localStats.totals))}</div></div>
          <div class="metric-card"><div class="metric-label">历史费用</div><div class="metric-value">${formatUsd(localStats.totals.cost)}</div></div>
          <div class="metric-card"><div class="metric-label">历史账号调用</div><div class="metric-value">${formatTotalsInline(localStats.byKind.account)}</div></div>
          <div class="metric-card"><div class="metric-label">历史 API 调用</div><div class="metric-value">${formatTotalsInline(localStats.byKind.api)}</div></div>
        </section>
        <section class="section-block">
          <h2>历史来源累计</h2>
          <table>
            <thead><tr><th>来源</th><th>输入</th><th>输出</th><th>缓存写入</th><th>缓存读取</th><th>请求</th><th>估算费用</th></tr></thead>
            <tbody>${historicalSourceRows || '<tr><td colspan="7" class="dim">暂无历史来源统计</td></tr>'}</tbody>
          </table>
        </section>
        <section class="section-block">
          <h2>历史来源模型占比</h2>
          <table>
            <thead><tr><th>来源</th><th>模型</th><th>占比</th><th>输入</th><th>输出</th><th>缓存写入</th><th>缓存读取</th><th>请求</th><th>估算费用</th></tr></thead>
            <tbody>${historicalSourceModelRows || '<tr><td colspan="9" class="dim">暂无历史来源模型统计</td></tr>'}</tbody>
          </table>
        </section>
        <section class="section-block">
          <h2>历史模型用量</h2>
          <table>
            <thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存写入</th><th>缓存读取</th><th>请求</th><th>估算费用</th></tr></thead>
            <tbody>${historicalModelRows || '<tr><td colspan="7" class="dim">暂无历史模型用量记录</td></tr>'}</tbody>
          </table>
        </section>
        <section class="section-block daily-section">
          <h2>历史每日统计</h2>
          <table>
            <thead><tr><th>日期</th><th>来源</th><th>输入</th><th>输出</th><th>缓存写入</th><th>缓存读取</th><th>请求</th><th>估算费用</th></tr></thead>
            <tbody>${historicalDailyCombinedRows || '<tr><td colspan="8" class="dim">暂无历史每日统计</td></tr>'}</tbody>
          </table>
        </section>
      </div>
    </details>
  ` : '';

  const cards = accounts
    .map(({ name, info, usage }) => {
      const email = escapeHtml(info?.email ?? '—');
      const plan = formatPlanLabel(info?.plan, true) || '—';
      const billingType = formatBillingType(info?.billingType);
      const subscriptionCreated = formatProfileDate(info?.subscriptionCreatedAt);
      const displayName = escapeHtml(info?.displayName ?? name);
      const safeName = escapeHtml(name);
      const usageError = usage ? '' : usageErrorByAccount.get(name);
      const quotaCache = getStoredUsageCache(name);
      const config = loadConfig();
      const isCurrentQuotaAccount = name === detectCurrentAccount(config) && !config.currentApiProvider;

      const sessionPct = usage ? usage.five_hour.utilization : null;
      const weeklyPct = usage ? usage.seven_day.utilization : null;
      const sonnetPct = usage?.seven_day_sonnet?.utilization ?? null;
      const sessionReset = usage ? formatQuotaTiming(usage.five_hour, quotaCache, isCurrentQuotaAccount).tooltipPrefix : '';
      const weeklyReset = usage ? formatQuotaTiming(usage.seven_day, quotaCache, isCurrentQuotaAccount).tooltipPrefix : '';
      const sonnetReset = formatResetTime(usage?.seven_day_sonnet?.resets_at);

      const makeBar = (val: number | null, label: string, sub: string) => {
        if (val === null) {
          return `<div class="usage-row">
            <div class="usage-label"><span>${label}</span><span class="dim">—</span></div>
            <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
            <div class="sub">${sub}</div>
          </div>`;
        }
        const color = usageColor(val);
        const width = Math.min(Math.round(val), 100);
        return `<div class="usage-row">
          <div class="usage-label"><span>${label}</span><span style="color:${color}">${pct(val)}</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:${width}%;background:${color}"></div></div>
          <div class="sub">${sub}</div>
        </div>`;
      };

      const extra = usage?.extra_usage?.is_enabled && usage.extra_usage.used_credits !== null
        ? `<div class="extra">额外额度: ${usage.extra_usage.used_credits?.toLocaleString()} / ${usage.extra_usage.monthly_limit?.toLocaleString()}</div>`
        : '';

      const noUsage = !usage
        ? `<div class="dim" style="margin-top:8px;font-size:0.85em">无法获取使用量数据${usageError ? `：${escapeHtml(usageError)}` : '（Token 可能已过期或请求过于频繁）'}</div>`
        : '';

      return `<div class="card">
        <div class="card-header">
          <div>
            <span class="account-name">${safeName}</span>
            <span class="badge">${plan}</span>
          </div>
          <div class="account-email">${email}</div>
          <div class="dim" style="font-size:0.82em">${displayName}</div>
          ${subscriptionCreated ? `<div class="dim" style="font-size:0.82em">订阅创建 ${escapeHtml(subscriptionCreated)}${billingType ? ` · ${escapeHtml(billingType)}` : ''}</div>` : ''}
        </div>
        ${makeBar(sessionPct, 'Session (5hr)', sessionReset)}
        ${makeBar(weeklyPct, 'Weekly (7 day)', weeklyReset)}
        ${sonnetPct !== null ? makeBar(sonnetPct, 'Weekly Sonnet', sonnetReset) : ''}
        ${extra}
        ${noUsage}
      </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px;
    max-width: 1180px;
  }
  h2 { margin-bottom: 16px; font-size: 1em; font-weight: 600; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
  .section-block { margin-bottom: 22px; }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
    margin-bottom: 8px;
  }
  .metric-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 12px 14px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .metric-label { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-bottom: 5px; }
  .metric-value { font-size: 1.15em; font-weight: 700; }
  .stats-meta, .note {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    margin-top: 8px;
  }
  .heatmap {
    display: grid;
    grid-template-rows: repeat(7, 16px);
    gap: 4px;
    align-items: center;
  }
  .heat-cell {
    width: 16px;
    height: 16px;
    border-radius: 2px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
  }
  .heat-layout { display: flex; gap: 8px; align-items: flex-start; }
  .heatmap-wrap { overflow-x: auto; padding-bottom: 6px; max-width: 100%; }
  .heat-axis-x {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    margin-bottom: 8px;
  }
  .heat-axis-y {
    display: grid;
    grid-template-rows: repeat(7, 16px);
    gap: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.75em;
    line-height: 16px;
    text-align: right;
    min-width: 16px;
  }
  .heat-1 { background: color-mix(in srgb, var(--vscode-charts-green) 28%, transparent); }
  .heat-2 { background: color-mix(in srgb, var(--vscode-charts-green) 48%, transparent); }
  .heat-3 { background: color-mix(in srgb, var(--vscode-charts-green) 70%, transparent); }
  .heat-4 { background: var(--vscode-charts-green); }
  .heat-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.78em;
  }
  .heat-legend {
    display: inline-flex;
    gap: 5px;
    align-items: center;
  }
  .card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 14px;
  }
  .card-header { margin-bottom: 12px; }
  .account-name { font-weight: 600; font-size: 1em; }
  .account-email { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 3px; }
  .badge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 3px;
    font-size: 0.72em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    margin-left: 7px;
    vertical-align: middle;
  }
  .usage-row { margin-bottom: 10px; }
  .usage-label { display: flex; justify-content: space-between; font-size: 0.83em; margin-bottom: 4px; }
  .progress-track {
    height: 6px;
    background: var(--vscode-progressBar-background, #333);
    overflow: hidden;
  }
  .progress-fill { height: 100%; }
  .sub { font-size: 0.75em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .extra { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  .dim { opacity: 0.5; }
  .mono { font-family: var(--vscode-editor-font-family); }
  table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    overflow: hidden;
  }
  th, td {
    padding: 7px 9px;
    border-bottom: 1px solid var(--vscode-panel-border);
    text-align: right;
    white-space: nowrap;
  }
  th:first-child, td:first-child { text-align: left; }
  th {
    background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
  }
  tr:last-child td { border-bottom: none; }
  .daily-total-row td {
    background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
    font-weight: 600;
  }
  .source-day-row td:first-child { border-bottom-color: transparent; }
  .source-day-row td:nth-child(2) {
    color: var(--vscode-descriptionForeground);
    padding-left: 20px;
  }
  .share-cell {
    display: grid;
    grid-template-columns: minmax(72px, 1fr) 46px;
    gap: 8px;
    align-items: center;
    min-width: 130px;
  }
  .share-track {
    height: 6px;
    background: var(--vscode-editorWidget-background, rgba(127,127,127,0.12));
    border: 1px solid var(--vscode-panel-border);
  }
  .share-fill {
    height: 100%;
    background: var(--vscode-charts-blue);
  }
  .history-block {
    border-top: 1px solid var(--vscode-panel-border);
    padding-top: 14px;
  }
  .history-block summary {
    cursor: pointer;
    color: var(--vscode-foreground);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .history-body {
    padding-top: 4px;
  }
  .refresh-btn {
    display: block;
    margin-top: 4px;
    padding: 5px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .refresh-btn:hover { background: var(--vscode-button-hoverBackground); }
  .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
</style>
</head>
<body>
  <div class="header-row">
    <h2>Claude 账户使用量</h2>
    <button class="refresh-btn" onclick="refresh()">刷新</button>
  </div>
  ${topStatsHtml}
  <section class="section-block">
    <h2>OAuth 额度窗口</h2>
    ${cards || '<div class="dim">还没有保存 OAuth 账户。</div>'}
  </section>
  ${detailStatsHtml}
  <section class="section-block daily-section">
    <h2>每日统计</h2>
    <table>
      <thead><tr><th>日期</th><th>来源</th><th>输入</th><th>输出</th><th>缓存写入</th><th>缓存读取</th><th>请求</th><th>估算费用</th></tr></thead>
      <tbody>${dailyCombinedRows || '<tr><td colspan="8" class="dim">暂无每日统计</td></tr>'}</tbody>
    </table>
  </section>
  ${historicalStatsHtml}
  <script>
    const vscode = acquireVsCodeApi();
    function refresh() { vscode.postMessage({ command: 'refresh' }); }
  </script>
</body>
</html>`;
}

// ─── 状态栏 ───────────────────────────────────────────────────────────────────

let statusBar: vscode.StatusBarItem;
let accountTreeProvider: ClaudeAccountsTreeProvider | undefined;
let accountStatusProvider: ClaudeStatusTreeProvider | undefined;
let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

type TreeNodeKind = 'current' | 'summary' | 'section' | 'action' | 'account' | 'quota' | 'token' | 'provider' | 'empty';

interface TreeNode {
  kind: TreeNodeKind;
  label: string;
  section?: 'actions' | 'accounts' | 'providers';
  accountName?: string;
  providerName?: string;
  commandId?: string;
  description?: string;
  tooltip?: string;
  icon?: string;
}

class ClaudeAccountsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  private usageByAccount = new Map<string, UsageData | null>();
  private loadingUsage = false;
  readonly onDidChangeTreeData = this.changeEmitter.event;

  refresh(forceUsage = false): void {
    if (forceUsage) {
      usageErrorByAccount.clear();
    }
    this.changeEmitter.fire(undefined);
    void this.refreshUsage(forceUsage);
  }

  private async refreshUsage(forceUsage = false): Promise<void> {
    if (this.loadingUsage) { return; }
    this.loadingUsage = true;
    const config = loadConfig();
    try {
      syncActiveCredentialsToCurrentAccount(config);
      const currentAccount = detectCurrentAccount(config);
      const accounts = [...config.accounts].sort((a, b) => {
        if (a.name === currentAccount) { return -1; }
        if (b.name === currentAccount) { return 1; }
        return 0;
      });
      const entries: Array<{ name: string; usage: UsageData | null }> = [];
      for (const account of accounts) {
        await refreshAccountProfileMetadata(account.name, forceUsage);
        entries.push({
          name: account.name,
          usage: await getUsage(account.name, forceUsage),
        });
        if (accounts.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, USAGE_REQUEST_SPACING_MS));
        }
      }
      this.usageByAccount.clear();
      for (const entry of entries) {
        this.usageByAccount.set(entry.name, entry.usage);
      }
      this.changeEmitter.fire(undefined);
      accountStatusProvider?.refresh();
    } finally {
      this.loadingUsage = false;
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const collapsible = element.kind === 'section' || element.kind === 'account'
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(
      element.label,
      collapsible
    );

    item.description = element.description;

    item.tooltip = element.tooltip ?? (element.description ? `${element.label} ${element.description}` : element.label);

    if (element.kind === 'current') {
      item.iconPath = new vscode.ThemeIcon('check');
    } else if (element.kind === 'summary') {
      item.iconPath = new vscode.ThemeIcon(element.icon ?? 'pulse');
    } else if (element.kind === 'action') {
      item.iconPath = new vscode.ThemeIcon(element.icon ?? 'circle-large-outline');
      if (element.commandId) {
        item.command = {
          command: element.commandId,
          title: element.label,
        };
      }
    } else if (element.kind === 'account') {
      item.iconPath = new vscode.ThemeIcon('account');
      item.contextValue = 'account';
      item.command = {
        command: 'claude-switcher.switchToAccount',
        title: 'Use Account',
        arguments: [element.accountName],
      };
    } else if (element.kind === 'quota') {
      item.iconPath = new vscode.ThemeIcon(element.icon ?? 'pulse');
    } else if (element.kind === 'token') {
      item.iconPath = new vscode.ThemeIcon(element.icon ?? 'graph-line');
    } else if (element.kind === 'provider') {
      item.iconPath = new vscode.ThemeIcon('server');
      item.contextValue = 'provider';
      item.command = {
        command: 'claude-switcher.switchToProvider',
        title: 'Use Provider',
        arguments: [element.providerName],
      };
    } else if (element.kind === 'empty') {
      item.iconPath = new vscode.ThemeIcon('info');
    }

    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    const config = loadConfig();
    const currentAccount = detectCurrentAccount(config);
    const currentProvider = config.currentApiProvider;

    if (!element) {
      return [
        { kind: 'section', label: '操作', section: 'actions' },
        { kind: 'section', label: 'OAuth 账号', section: 'accounts' },
        { kind: 'section', label: 'API Providers', section: 'providers' },
      ];
    }

    if (element.kind !== 'section') {
      if (element.kind === 'account') {
        const usage = element.accountName ? this.usageByAccount.get(element.accountName) : undefined;
        const quotaCache = element.accountName ? getStoredUsageCache(element.accountName) : undefined;
        const isCurrentQuotaAccount = element.accountName === currentAccount && !currentProvider;
        const localStats = getLocalTokenStats();
        const todayKey = formatLocalDate(new Date());
        const todayAccountStats = element.accountName
          ? getSourceDayTotals(localStats, 'account', element.accountName, todayKey)
          : undefined;
        const todayAccountModel = element.accountName
          ? getSourceDayTopModel(localStats, 'account', element.accountName, todayKey)
          : undefined;
        const tokenNodes: TreeNode[] = [
          {
            kind: 'token',
            label: `Today    ${formatTotalsInline(todayAccountStats)}`,
            description: '',
            tooltip: todayAccountStats
              ? [
                  `今日总 Token: ${formatCompactNumber(totalTokens(todayAccountStats))}`,
                  `今日估算费用: ${formatUsd(todayAccountStats.cost)}`,
                ].join('\n')
              : '今日暂无已归因到账户的本地用量',
            icon: 'graph-line',
          },
          {
            kind: 'token',
            label: `I/O      in ${formatTokenShort(todayAccountStats?.input ?? 0)} · out ${formatTokenShort(todayAccountStats?.output ?? 0)}`,
            tooltip: [
              `输入: ${formatCompactNumber(todayAccountStats?.input ?? 0)}`,
              `输出: ${formatCompactNumber(todayAccountStats?.output ?? 0)}`,
            ].join('\n'),
            icon: 'arrow-swap',
          },
          {
            kind: 'token',
            label: `Cache    write ${formatTokenShort(todayAccountStats?.cacheCreate ?? 0)} · read ${formatTokenShort(todayAccountStats?.cacheRead ?? 0)}`,
            tooltip: [
              `缓存写入: ${formatCompactNumber(todayAccountStats?.cacheCreate ?? 0)}`,
              `缓存读取: ${formatCompactNumber(todayAccountStats?.cacheRead ?? 0)}`,
            ].join('\n'),
            icon: 'database',
          },
          {
            kind: 'token',
            label: todayAccountModel
              ? `Model    ${todayAccountModel.model} · ${formatTokenShort(todayAccountModel.output)} out · ${formatUsd(todayAccountModel.cost)}`
              : 'Model    今日暂无',
            tooltip: todayAccountModel
              ? [
                  `今日模型: ${todayAccountModel.model}`,
                  `输入: ${formatCompactNumber(todayAccountModel.input)}`,
                  `输出: ${formatCompactNumber(todayAccountModel.output)}`,
                  `缓存写入: ${formatCompactNumber(todayAccountModel.cacheCreate)}`,
                  `缓存读取: ${formatCompactNumber(todayAccountModel.cacheRead)}`,
                  `估算费用: ${formatUsd(todayAccountModel.cost)}`,
                ].join('\n')
              : '今日暂无已归因到账户的模型用量',
            icon: 'symbol-method',
          },
        ];
        if (!usage) {
          const usageError = element.accountName ? usageErrorByAccount.get(element.accountName) : undefined;
          const readLabel = this.loadingUsage
            ? '读取中...'
            : (usageError ?? '未读取');
          const readDescription = usageError?.includes('429')
            ? '请求过于频繁，稍后自动重试'
            : (this.loadingUsage ? '' : '刷新重试');
          return [
            {
              kind: 'quota',
              label: `Session  ${readLabel}`,
              description: readDescription,
              icon: 'dash',
            },
            {
              kind: 'quota',
              label: `Weekly   ${readLabel}`,
              description: readDescription,
              icon: 'dash',
            },
            ...tokenNodes,
          ];
        }
        const usageError = element.accountName ? usageErrorByAccount.get(element.accountName) : undefined;
        const quotaMetaNodes = quotaCache
          ? [this.buildQuotaCacheNode(quotaCache, isCurrentQuotaAccount)]
          : [];
        const errorNodes: TreeNode[] = usageError
          ? [{
              kind: 'quota',
              label: `Quota    ${usageError}`,
              description: '保留上次成功额度',
              tooltip: `额度刷新失败: ${usageError}\n当前显示的是上次成功读取的额度。`,
              icon: 'warning',
            }]
          : [];
        return [
          this.buildQuotaNode('Session', usage.five_hour, quotaCache, isCurrentQuotaAccount),
          this.buildQuotaNode('Weekly', usage.seven_day, quotaCache, isCurrentQuotaAccount),
          ...quotaMetaNodes,
          ...errorNodes,
          ...tokenNodes,
        ];
      }
      return [];
    }

    if (element.section === 'actions') {
      return [
        {
          kind: 'action',
          label: '添加 OAuth 账号',
          description: '官方账号',
          commandId: 'claude-switcher.add',
          icon: 'add',
        },
        {
          kind: 'action',
          label: '添加 API Provider',
          description: 'Anthropic 兼容端点',
          commandId: 'claude-switcher.addProvider',
          icon: 'server-process',
        },
        {
          kind: 'action',
          label: '打开用量统计',
          description: '全局面板',
          commandId: 'claude-switcher.usage',
          icon: 'graph',
        },
      ];
    }

    if (element.section === 'accounts') {
      if (config.accounts.length === 0) {
        return [{ kind: 'empty', label: '还没有保存账号，点击上方添加。' }];
      }
      return config.accounts.map((account) => {
        const info = readAccountInfo(account.name);
        const usage = this.usageByAccount.get(account.name);
        const isCurrent = account.name === currentAccount && !currentProvider;
        const label = `${isCurrent ? '✓ ' : ''}${account.name}`;
        const plan = formatPlanLabel(info?.plan);
        const subscriptionDate = formatProfileDate(info?.subscriptionCreatedAt, true);
        const billingType = formatBillingType(info?.billingType);
        const quotaCache = getStoredUsageCache(account.name);
        const isCurrentQuotaAccount = account.name === currentAccount && !currentProvider;
        const fiveHourTiming = usage ? formatQuotaTiming(usage.five_hour, quotaCache, isCurrentQuotaAccount) : undefined;
        const weeklyTiming = usage ? formatQuotaTiming(usage.seven_day, quotaCache, isCurrentQuotaAccount) : undefined;
        const description = [
          plan,
          subscriptionDate ? `订阅 ${subscriptionDate}` : '',
          info?.email || account.description,
        ].filter(Boolean).join(' · ');
        const tooltipParts = [
          info?.email || account.description || account.name,
          plan ? `计划: ${plan}` : '',
          billingType ? `计费类型: ${billingType}` : '',
          info?.subscriptionCreatedAt ? `订阅创建: ${formatProfileDate(info.subscriptionCreatedAt)}` : '',
          info?.organization ? `额度层级/组织: ${info.organization}` : '',
          usage && fiveHourTiming ? `5 小时额度: ${Math.round(usage.five_hour.utilization)}% (${fiveHourTiming.tooltipPrefix})` : '',
          usage && weeklyTiming ? `7 天额度: ${Math.round(usage.seven_day.utilization)}% (${weeklyTiming.tooltipPrefix})` : '',
        ].filter(Boolean).join('\n');
        return { kind: 'account', label, accountName: account.name, description, tooltip: tooltipParts };
      });
    }

    if (element.section === 'providers') {
      const providers = config.apiProviders ?? [];
      if (providers.length === 0) {
        return [{ kind: 'empty', label: '没有 API Provider。' }];
      }
      return providers.map((provider) => {
        const isCurrent = provider.name === currentProvider;
        const label = `${isCurrent ? '✓ ' : ''}${provider.name}`;
        const description = [provider.model, provider.baseUrl].filter(Boolean).join(' · ');
        return { kind: 'provider', label, providerName: provider.name, description };
      });
    }

    return [];
  }

  private buildQuotaNode(label: string, window: UsageWindow, cache?: StoredUsageCache, isCurrentAccount = false): TreeNode {
    const pctValue = Math.round(window.utilization);
    const bar = this.renderUsageBar(pctValue);
    const timing = formatQuotaTiming(window, cache, isCurrentAccount);
    return {
      kind: 'quota',
      label: `${label.padEnd(7)} ${bar} ${pctValue}%`,
      description: timing.description,
      tooltip: [
        `${label} 已用: ${pctValue}%`,
        timing.tooltip,
      ].join('\n'),
      icon: pctValue >= 95 ? 'warning' : (pctValue >= 70 ? 'flame' : 'pulse'),
    };
  }

  private buildQuotaCacheNode(cache: StoredUsageCache, isCurrentAccount: boolean): TreeNode {
    const nextRefresh = getNextQuotaRefreshAt(cache);
    return {
      kind: 'quota',
      label: `更新    ${formatUsageCacheTime(cache.fetchedAt)}`,
      description: isCurrentAccount ? '当前账号实时刷新' : `下次 ${formatUsageCacheTime(nextRefresh)}`,
      tooltip: [
        `额度缓存更新时间: ${new Date(cache.fetchedAt).toLocaleString('zh-CN', { hour12: false })}`,
        isCurrentAccount
          ? '当前登录账号会按常规刷新'
          : `非当前账号只在 5h 窗口重置后自动刷新: ${new Date(nextRefresh).toLocaleString('zh-CN', { hour12: false })}`,
      ].join('\n'),
      icon: 'history',
    };
  }

  private renderUsageBar(percent: number): string {
    const total = 10;
    const filled = Math.max(0, Math.min(total, Math.round((percent / 100) * total)));
    return `${'█'.repeat(filled)}${'░'.repeat(total - filled)}`;
  }
}

function getStatusTreeNodes(): TreeNode[] {
  const config = loadConfig();
  const currentAccount = detectCurrentAccount(config);
  const currentProvider = config.currentApiProvider;
  const localStats = getLocalTokenStats();
  const todayKey = formatLocalDate(new Date());
  const todayStats = localStats.byDay.find((row) => row.date === todayKey);
  const todayTopModel = localStats.byDayModel
    .filter((row) => row.date === todayKey)
    .sort((a, b) => b.cost - a.cost || b.output - a.output)[0];
  const currentLabel = currentProvider
    ? `当前 Provider: ${currentProvider}`
    : `当前账号: ${currentAccount ?? 'default'}`;
  const currentDescription = currentProvider
    ? config.apiProviders?.find((p) => p.name === currentProvider)?.baseUrl
    : [
        currentAccount ? readAccountInfo(currentAccount)?.email : undefined,
      ].filter(Boolean).join(' · ');

  return [
    {
      kind: 'current',
      label: currentLabel,
      description: currentDescription,
    },
    {
      kind: 'summary',
      label: '今日用量',
      description: `${formatCompactNumber(todayStats?.output ?? 0)} out · ${formatCompactNumber(todayStats?.input ?? 0)} in · ${formatUsd(todayStats?.cost ?? 0)}`,
      tooltip: [
        `今日输入: ${formatCompactNumber(todayStats?.input ?? 0)}`,
        `今日输出: ${formatCompactNumber(todayStats?.output ?? 0)}`,
        `今日缓存写入: ${formatCompactNumber(todayStats?.cacheCreate ?? 0)}`,
        `今日缓存读取: ${formatCompactNumber(todayStats?.cacheRead ?? 0)}`,
        `今日估算费用: ${formatUsd(todayStats?.cost ?? 0)}`,
      ].join('\n'),
      icon: 'graph',
    },
    {
      kind: 'summary',
      label: todayTopModel ? '今日主要模型' : '今日模型用量',
      description: todayTopModel
        ? `${todayTopModel.model} · ${formatCompactNumber(todayTopModel.output)} out · ${formatUsd(todayTopModel.cost)}`
        : '',
      tooltip: todayTopModel
        ? [
            `今日模型: ${todayTopModel.model}`,
            `今日输入: ${formatCompactNumber(todayTopModel.input)}`,
            `今日输出: ${formatCompactNumber(todayTopModel.output)}`,
            `今日缓存写入: ${formatCompactNumber(todayTopModel.cacheCreate)}`,
            `今日缓存读取: ${formatCompactNumber(todayTopModel.cacheRead)}`,
            `今日估算费用: ${formatUsd(todayTopModel.cost)}`,
          ].join('\n')
        : '今日暂无本地模型用量记录',
      icon: 'symbol-method',
    },
  ];
}

class ClaudeStatusTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.tooltip = element.tooltip ?? (element.description ? `${element.label} ${element.description}` : element.label);
    if (element.kind === 'current') {
      item.iconPath = new vscode.ThemeIcon('check');
    } else {
      item.iconPath = new vscode.ThemeIcon(element.icon ?? 'pulse');
    }
    return item;
  }

  getChildren(): TreeNode[] {
    return getStatusTreeNodes();
  }
}

function refreshStatusBar(): void {
  const config = loadConfig();

  // 检查是否在使用 API Provider
  if (config.currentApiProvider) {
    const provider = config.apiProviders?.find((p) => p.name === config.currentApiProvider);
    if (provider) {
      statusBar.text = `$(server) ${provider.name}`;
      statusBar.tooltip = `当前 API Provider: ${provider.name}\n${provider.baseUrl}\n点击切换`;
      statusBar.show();
      accountTreeProvider?.refresh();
      accountStatusProvider?.refresh();
      return;
    }
  }

  // OAuth 账户模式
  const current = detectCurrentAccount(config);
  const info = current ? readAccountInfo(current) : null;
  const emailHint = info?.email ? ` (${info.email})` : '';
  statusBar.text = `$(account) ${current ?? 'default'}`;
  statusBar.tooltip = `当前 Claude 账户: ${current ?? 'default'}${emailHint}\n点击切换`;
  statusBar.show();
  accountTreeProvider?.refresh();
  accountStatusProvider?.refresh();
}

function refreshManagerData(forceUsage = false): void {
  if (forceUsage) {
    usageErrorByAccount.clear();
    localStatsCache = undefined;
  }
  syncActiveCredentialsToCurrentAccount();
  accountTreeProvider?.refresh(forceUsage);
  accountStatusProvider?.refresh();
  if (usagePanel) {
    void updateUsagePanel(loadConfig(), forceUsage);
  }
}

// ─── Quick Pick 条目 ──────────────────────────────────────────────────────────

function buildAccountQuickPickItems(
  config: Config,
  currentName?: string,
  usageMap?: Map<string, UsageData | null>
) {
  return config.accounts.map((a) => {
    const info = readAccountInfo(a.name);
    const isCurrent = a.name === currentName;
    const planLabel = formatPlanLabel(info?.plan) || '?';
    const subscriptionDate = formatProfileDate(info?.subscriptionCreatedAt, true);
    const usage = usageMap?.get(a.name);

    let usageSuffix = '';
    if (usage) {
      const s = Math.round(usage.five_hour.utilization);
      const w = Math.round(usage.seven_day.utilization);
      usageSuffix = `  ·  Session ${s}%  ·  Weekly ${w}%`;
    }

    return {
      label: (isCurrent ? '$(check) ' : '$(account) ') + a.name,
      description: info?.email ?? a.description ?? '',
      detail: info
        ? `${[planLabel, subscriptionDate ? `订阅 ${subscriptionDate}` : '', info.organization || info.displayName || ''].filter(Boolean).join('  ·  ')}${usageSuffix}`
        : usageSuffix,
      accountName: a.name,
    };
  });
}

// ─── 命令：切换账户 ───────────────────────────────────────────────────────────

async function commandSwitch(): Promise<void> {
  const config = loadConfig();
  const hasAccounts = config.accounts.length > 0;
  const hasProviders = (config.apiProviders?.length ?? 0) > 0;

  if (!hasAccounts && !hasProviders) {
    const action = await vscode.window.showInformationMessage(
      '还没有保存任何账户或 API Provider',
      '添加账户',
      '添加 Provider'
    );
    if (action === '添加账户') {await commandAdd();}
    else if (action === '添加 Provider') {await commandAddApiProvider();}
    return;
  }

  type SwitchItem = { label: string; description: string; detail: string; itemType: 'account' | 'provider'; itemName: string };
  const items: SwitchItem[] = [];
  const currentAccount = detectCurrentAccount(config);
  const currentProvider = config.currentApiProvider;

  // 添加 API Providers（优先显示）
  if (config.apiProviders) {
    for (const p of config.apiProviders) {
      const isCurrent = p.name === currentProvider;
      items.push({
        label: (isCurrent ? '$(check) ' : '$(server) ') + p.name,
        description: p.baseUrl,
        detail: p.model ? `Model: ${p.model}` : '默认模型',
        itemType: 'provider',
        itemName: p.name,
      });
    }
  }

  // 添加 OAuth 账户
  for (const a of config.accounts) {
    const info = readAccountInfo(a.name);
    const isCurrent = a.name === currentAccount && !currentProvider;
    const planLabel = formatPlanLabel(info?.plan) || '?';
    const subscriptionDate = formatProfileDate(info?.subscriptionCreatedAt, true);
    items.push({
      label: (isCurrent ? '$(check) ' : '$(account) ') + a.name,
      description: info?.email ?? a.description ?? '',
      detail: [planLabel, subscriptionDate ? `订阅 ${subscriptionDate}` : '', info?.organization || info?.displayName || ''].filter(Boolean).join('  ·  '),
      itemType: 'account',
      itemName: a.name,
    });
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: '切换账户或 API Provider',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) {return;}

  // 已经是当前选中的，不做任何操作
  if (selected.itemType === 'provider' && selected.itemName === currentProvider) {return;}
  if (selected.itemType === 'account' && selected.itemName === currentAccount && !currentProvider) {return;}

  try {
    if (selected.itemType === 'provider') {
      switchToApiProvider(selected.itemName);
    } else {
      await switchToAccount(selected.itemName);
    }
    refreshStatusBar();
    const action = await vscode.window.showInformationMessage(
      `已切换到 "${selected.itemName}"，重载窗口后生效`,
      '立即重载'
    );
    if (action === '立即重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`切换失败: ${message}`);
  }
}

// ─── 命令：使用量面板 ─────────────────────────────────────────────────────────

let usagePanel: vscode.WebviewPanel | undefined;

async function commandUsage(): Promise<void> {
  const config = loadConfig();
  if (usagePanel) {
    usagePanel.reveal();
  } else {
    usagePanel = vscode.window.createWebviewPanel(
      'claudeUsage',
      'CC Manager 全局统计',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    usagePanel.onDidDispose(() => {
      usagePanel = undefined;
    });
    usagePanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'refresh') {
        usageErrorByAccount.clear();
        localStatsCache = undefined;
        await updateUsagePanel(loadConfig(), true);
      }
    });
  }

  await updateUsagePanel(config);
}

async function updateUsagePanel(config: Config, forceUsage = false): Promise<void> {
  if (!usagePanel) {
    return;
  }
  syncActiveCredentialsToCurrentAccount(config);

  // 先展示加载中
  usagePanel.webview.html = buildUsageHtml(
    config.accounts.map((a) => ({
      name: a.name,
      info: readAccountInfo(a.name),
      usage: null,
    })),
    getLocalTokenStats()
  );

  // 串行拉取，避免 usage endpoint 对同一客户端的短时间并发请求过敏。
  const currentAccount = detectCurrentAccount(config);
  const accounts = [...config.accounts].sort((a, b) => {
    if (a.name === currentAccount) { return -1; }
    if (b.name === currentAccount) { return 1; }
    return 0;
  });
  const results: Array<{ name: string; info: AccountInfo | null; usage: UsageData | null }> = [];
  for (const a of accounts) {
    await refreshAccountProfileMetadata(a.name, forceUsage);
    results.push({
      name: a.name,
      info: readAccountInfo(a.name),
      usage: await getUsage(a.name, forceUsage),
    });
    if (accounts.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, USAGE_REQUEST_SPACING_MS));
    }
  }

  if (usagePanel) {
    usagePanel.webview.html = buildUsageHtml(results, getLocalTokenStats());
  }
}

function resolveAccountName(arg: unknown): string | undefined {
  if (typeof arg === 'string') { return arg; }
  if (arg && typeof arg === 'object') {
    const node = arg as Partial<TreeNode> & { label?: unknown };
    if (typeof node.accountName === 'string') { return node.accountName; }
    if (typeof node.label === 'string') { return node.label.replace(/^✓\s*/, ''); }
  }
  return undefined;
}

function resolveProviderName(arg: unknown): string | undefined {
  if (typeof arg === 'string') { return arg; }
  if (arg && typeof arg === 'object') {
    const node = arg as Partial<TreeNode> & { label?: unknown };
    if (typeof node.providerName === 'string') { return node.providerName; }
    if (typeof node.label === 'string') { return node.label.replace(/^✓\s*/, ''); }
  }
  return undefined;
}

async function commandSwitchToAccount(arg?: unknown): Promise<void> {
  const name = resolveAccountName(arg);
  if (!name) { return; }
  const config = loadConfig();
  const currentAccount = detectCurrentAccount(config);
  if (name === currentAccount && !config.currentApiProvider) { return; }

  try {
    await switchToAccount(name);
    refreshStatusBar();
    vscode.window.showInformationMessage(`已切换到账号 "${name}"，重载窗口后生效`, '立即重载')
      .then(async (action) => {
        if (action === '立即重载') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`切换失败: ${message}`);
  }
}

async function commandSwitchToProvider(arg?: unknown): Promise<void> {
  const name = resolveProviderName(arg);
  if (!name) { return; }
  const config = loadConfig();
  if (name === config.currentApiProvider) { return; }

  try {
    switchToApiProvider(name);
    refreshStatusBar();
    vscode.window.showInformationMessage(`已切换到 Provider "${name}"，重载窗口后生效`, '立即重载')
      .then(async (action) => {
        if (action === '立即重载') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`切换失败: ${message}`);
  }
}

// ─── 命令：添加账户 ───────────────────────────────────────────────────────────

async function commandAdd(): Promise<void> {
  type AddOption = { label: string; id: 'save-current' | 'new-login' };
  const options: AddOption[] = [];
  if (fs.existsSync(CLAUDE_CREDS)) {
    options.push({ label: '$(save) 保存当前 Claude 会话为账户', id: 'save-current' });
  }
  options.push({ label: '$(sign-in) 登录新账户', id: 'new-login' });

  const action = await vscode.window.showQuickPick(options, { placeHolder: '如何添加账户？' });
  if (!action) {
    return;
  }

  if (action.id === 'save-current') {
    await saveCurrentSession();
  } else {
    await loginNewAccount();
  }
}

async function saveCurrentSession(): Promise<void> {
  const config = loadConfig();
  let autoName = '';
  let profile: OAuthProfile | null = null;
  try {
    const claudeJsonPath = path.join(CLAUDE_DIR, '.claude.json');
    if (fs.existsSync(claudeJsonPath)) {
      const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as ClaudeJson;
      const email = claudeJson?.oauthAccount?.emailAddress ?? '';
      if (email) {
        autoName = generateAccountName(email, config.accounts);
      }
    }
    if (!autoName && fs.existsSync(CLAUDE_CREDS)) {
      const creds = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf-8')) as Credentials;
      const accessToken = creds?.claudeAiOauth?.accessToken;
      if (accessToken) {
        profile = await fetchOAuthProfile(accessToken);
        const email = profile?.account?.email ?? '';
        if (email) {
          autoName = generateAccountName(email, config.accounts);
        }
      }
    }
  } catch {}

  const name = await vscode.window.showInputBox({
    prompt: '输入账户名称',
    value: autoName,
    placeHolder: '例如：scotlandmail_01',
    validateInput: (v) => {
      if (!v?.trim()) {return '名称不能为空';}
      if (!/^[\w-]+$/.test(v)) {return '只能包含字母、数字、- 和 _';}
      if (config.accounts.find((a) => a.name === v)) {return '该名称已存在';}
      return null;
    },
  });
  if (!name) {
    return;
  }

  const accountDir = getAccountDir(name);
  fs.mkdirSync(accountDir, { recursive: true });
  fs.copyFileSync(CLAUDE_CREDS, path.join(accountDir, '.credentials.json'));
  const claudeJsonSrc = path.join(CLAUDE_DIR, '.claude.json');
  if (fs.existsSync(claudeJsonSrc)) {
    fs.copyFileSync(claudeJsonSrc, path.join(accountDir, '.claude.json'));
  } else if (profile) {
    fs.writeFileSync(
      path.join(accountDir, '.claude.json'),
      JSON.stringify(profileToClaudeJson(profile), null, 2),
      'utf-8'
    );
  }

  if (profile) {
    updateCredentialsPlanFromProfile(path.join(accountDir, '.credentials.json'), profile);
  } else {
    await cacheProfileForCredentials(
      path.join(accountDir, '.credentials.json'),
      path.join(accountDir, '.claude.json')
    );
  }

  const info = readAccountInfo(name);
  config.accounts.push({ name, description: info?.email ?? '' });
  config.currentAccount = name;
  saveConfig(config);

  vscode.window.showInformationMessage(
    `账户 "${name}"${info?.email ? ` (${info.email})` : ''} 已保存`
  );
  refreshStatusBar();
}

async function loginNewAccount(): Promise<void> {
  const tempName = `_pending_${Date.now()}`;
  const accountDir = getAccountDir(tempName);
  fs.mkdirSync(accountDir, { recursive: true });

  const terminal = vscode.window.createTerminal({
    name: 'Claude 登录新账户',
    shellPath: 'cmd.exe',
    env: { CLAUDE_CONFIG_DIR: accountDir },
  });
  terminal.show();
  terminal.sendText('claude');

  vscode.window.showInformationMessage('请在终端中完成 Claude 登录，登录成功后将自动保存账户');

  const credPath = path.join(accountDir, '.credentials.json');
  const claudeJsonPath = path.join(accountDir, '.claude.json');
  let attempts = 0;

  const poll = setInterval(async () => {
    attempts++;
    if (fs.existsSync(credPath)) {
      clearInterval(poll);
      let autoName = '';
      const profile = await cacheProfileForCredentials(credPath, claudeJsonPath);
      const profileEmail = profile?.account?.email ?? '';
      if (profileEmail) {
        autoName = generateAccountName(profileEmail, loadConfig().accounts);
      }

      // .claude.json 可能在 credentials 出现后数秒才写入，等待最多 5 秒
      if (!fs.existsSync(claudeJsonPath)) {
        await new Promise<void>((resolve) => {
          let waited = 0;
          const waitForClaudeJson = setInterval(() => {
            waited += 500;
            if (fs.existsSync(claudeJsonPath) || waited >= 5000) {
              clearInterval(waitForClaudeJson);
              resolve();
            }
          }, 500);
        });
      }

      if (!autoName && fs.existsSync(claudeJsonPath)) {
        try {
          const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as ClaudeJson;
          const email = claudeJson?.oauthAccount?.emailAddress ?? '';
          if (email) {
            autoName = generateAccountName(email, loadConfig().accounts);
          }
        } catch {}
      }

      const currentConfig = loadConfig();
      const name = await vscode.window.showInputBox({
        prompt: '登录成功！确认账户名称',
        value: autoName,
        validateInput: (v) => {
          if (!v?.trim()) {return '名称不能为空';}
          if (!/^[\w-]+$/.test(v)) {return '只能包含字母、数字、- 和 _';}
          if (currentConfig.accounts.find((a) => a.name === v)) {return '该名称已存在';}
          return null;
        },
      });

      if (!name) {
        fs.rmSync(accountDir, { recursive: true, force: true });
        return;
      }

      const finalDir = getAccountDir(name);
      fs.renameSync(accountDir, finalDir);
      const info = readAccountInfo(name);
      currentConfig.accounts.push({ name, description: info?.email ?? '' });
      saveConfig(currentConfig);
      vscode.window.showInformationMessage(`账户 "${name}"${info?.email ? ` (${info.email})` : ''} 已保存`);
      refreshStatusBar();
    } else if (attempts >= 300) {
      clearInterval(poll);
      fs.rmSync(accountDir, { recursive: true, force: true });
      vscode.window.showWarningMessage('等待登录超时，请重新尝试添加账户');
    }
  }, 1000);
}

// ─── 命令：删除账户 ───────────────────────────────────────────────────────────

async function commandRemove(): Promise<void> {
  const config = loadConfig();
  if (config.accounts.length === 0) {
    vscode.window.showInformationMessage('没有可删除的账户');
    return;
  }

  const current = detectCurrentAccount(config);
  const items = buildAccountQuickPickItems(config, current);
  const selected = await vscode.window.showQuickPick(items, { placeHolder: '选择要删除的账户' });
  if (!selected) {
    return;
  }

  const info = readAccountInfo(selected.accountName);
  const label = info?.email
    ? `"${selected.accountName}" (${info.email})`
    : `"${selected.accountName}"`;

  const confirm = await vscode.window.showWarningMessage(
    `确定删除账户 ${label}？此操作不可撤销。`,
    { modal: true },
    '删除'
  );
  if (confirm !== '删除') {
    return;
  }

  config.accounts = config.accounts.filter((a) => a.name !== selected.accountName);
  if (config.currentAccount === selected.accountName) {
    config.currentAccount = undefined;
  }
  if (config.quotaUsageCache) {
    delete config.quotaUsageCache[selected.accountName];
  }
  saveConfig(config);

  const accountDir = getAccountDir(selected.accountName);
  if (fs.existsSync(accountDir)) {
    fs.rmSync(accountDir, { recursive: true, force: true });
  }
  usageCache.delete(selected.accountName);
  usageRetryAfterByAccount.delete(selected.accountName);

  vscode.window.showInformationMessage(`账户 ${label} 已删除`);
  refreshStatusBar();
}

async function commandRemoveAccountNode(arg?: unknown): Promise<void> {
  const accountName = resolveAccountName(arg);
  if (!accountName) {
    await commandRemove();
    return;
  }

  const config = loadConfig();
  const account = config.accounts.find((a) => a.name === accountName);
  if (!account) {
    vscode.window.showWarningMessage(`账号 "${accountName}" 不存在`);
    return;
  }

  const info = readAccountInfo(accountName);
  const label = info?.email
    ? `"${accountName}" (${info.email})`
    : `"${accountName}"`;
  const confirm = await vscode.window.showWarningMessage(
    `确定删除账户 ${label}？此操作不可撤销。`,
    { modal: true },
    '删除'
  );
  if (confirm !== '删除') {
    return;
  }

  config.accounts = config.accounts.filter((a) => a.name !== accountName);
  if (config.currentAccount === accountName) {
    config.currentAccount = undefined;
  }
  if (config.quotaUsageCache) {
    delete config.quotaUsageCache[accountName];
  }
  saveConfig(config);

  const accountDir = getAccountDir(accountName);
  if (fs.existsSync(accountDir)) {
    fs.rmSync(accountDir, { recursive: true, force: true });
  }
  usageCache.delete(accountName);
  usageRetryAfterByAccount.delete(accountName);

  vscode.window.showInformationMessage(`账户 ${label} 已删除`);
  refreshStatusBar();
}

async function commandRenameAccountNode(arg?: unknown): Promise<void> {
  const oldName = resolveAccountName(arg);
  const config = loadConfig();
  const account = oldName
    ? config.accounts.find((a) => a.name === oldName)
    : undefined;

  let sourceName = oldName;
  if (!sourceName || !account) {
    if (config.accounts.length === 0) {
      vscode.window.showInformationMessage('没有可重命名的账户');
      return;
    }
    const current = detectCurrentAccount(config);
    const selected = await vscode.window.showQuickPick(
      buildAccountQuickPickItems(config, current),
      { placeHolder: '选择要重命名的账户' }
    );
    if (!selected) { return; }
    sourceName = selected.accountName;
  }

  const sourceAccount = config.accounts.find((a) => a.name === sourceName);
  if (!sourceAccount) {
    vscode.window.showWarningMessage(`账号 "${sourceName}" 不存在`);
    return;
  }

  const newName = await vscode.window.showInputBox({
    prompt: `将账户 "${sourceName}" 重命名为`,
    value: sourceName,
    validateInput: (v) => {
      const value = v?.trim();
      if (!value) { return '名称不能为空'; }
      if (!/^[\w-]+$/.test(value)) { return '只能包含字母、数字、- 和 _'; }
      if (value === sourceName) { return null; }
      if (config.accounts.find((a) => a.name === value)) { return '该名称已存在'; }
      if (fs.existsSync(getAccountDir(value))) { return '该账户目录已存在'; }
      return null;
    },
  });
  const targetName = newName?.trim();
  if (!targetName || targetName === sourceName) {
    return;
  }

  const oldDir = getAccountDir(sourceName);
  const newDir = getAccountDir(targetName);
  if (!fs.existsSync(oldDir)) {
    vscode.window.showErrorMessage(`账户目录不存在: ${oldDir}`);
    return;
  }
  if (fs.existsSync(newDir)) {
    vscode.window.showErrorMessage(`目标账户目录已存在: ${newDir}`);
    return;
  }

  try {
    fs.renameSync(oldDir, newDir);
    sourceAccount.name = targetName;
    if (sourceAccount.description === sourceName) {
      sourceAccount.description = targetName;
    }
    if (config.currentAccount === sourceName) {
      config.currentAccount = targetName;
    }
    if (config.usageAttributionHistory) {
      for (const event of config.usageAttributionHistory) {
        if (event.sourceType === 'account' && event.sourceName === sourceName) {
          event.sourceName = targetName;
        }
      }
    }
    if (config.quotaUsageCache?.[sourceName]) {
      config.quotaUsageCache[targetName] = config.quotaUsageCache[sourceName];
      delete config.quotaUsageCache[sourceName];
    }
    saveConfig(config);
    const cachedUsage = usageCache.get(sourceName);
    usageCache.delete(sourceName);
    if (cachedUsage) {
      usageCache.set(targetName, cachedUsage);
    }
    const retryAfter = usageRetryAfterByAccount.get(sourceName);
    usageRetryAfterByAccount.delete(sourceName);
    if (retryAfter) {
      usageRetryAfterByAccount.set(targetName, retryAfter);
    }
    localStatsCache = undefined;
    vscode.window.showInformationMessage(`账户已重命名: "${sourceName}" -> "${targetName}"`);
    refreshManagerData(true);
    refreshStatusBar();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`重命名失败: ${message}`);
  }
}

// ─── 命令：当前账户详情 ───────────────────────────────────────────────────────

function commandWhoami(): void {
  const config = loadConfig();

  // 检查是否在使用 API Provider
  if (config.currentApiProvider) {
    const provider = config.apiProviders?.find((p) => p.name === config.currentApiProvider);
    if (provider) {
      vscode.window.showInformationMessage(
        [`API Provider: ${provider.name}`, `Base URL: ${provider.baseUrl}`, `Model: ${provider.model || '默认'}`].join('\n'),
        { modal: true },
        '确定'
      );
      return;
    }
  }

  const current = detectCurrentAccount(config);
  if (!current) {
    vscode.window.showInformationMessage('当前使用默认 Claude 账户（未通过本扩展管理）');
    return;
  }
  const info = readAccountInfo(current);
  if (!info) {
    vscode.window.showInformationMessage(`当前账户: ${current}`);
    return;
  }
  const planLabel = formatPlanLabel(info.plan, true) || '—';
  const billingType = formatBillingType(info.billingType) || '—';
  const subscriptionCreated = formatProfileDate(info.subscriptionCreatedAt) || '—';
  vscode.window.showInformationMessage(
    [
      `账户名: ${current}`,
      `邮箱: ${info.email || '—'}`,
      `姓名: ${info.displayName || '—'}`,
      `组织: ${info.organization || '—'}`,
      `计划: ${planLabel}`,
      `计费类型: ${billingType}`,
      `订阅创建: ${subscriptionCreated}`,
    ].join('\n'),
    { modal: true },
    '确定'
  );
}

// ─── 命令：添加 API Provider ───────────────────────────────────────────────────

interface ProviderPreset {
  name: string;
  baseUrl: string;
  model: string;
  description: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: 'GLM-5.1',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'GLM-5.1',
    description: '智谱最新旗舰模型，面向 Coding/Agent',
  },
  {
    name: 'GLM-5',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'GLM-5',
    description: '智谱旗舰模型，支持深度思考',
  },
];

async function commandAddApiProvider(): Promise<void> {
  // 先选择预设或自定义
  type PresetOption = { label: string; description: string; preset?: ProviderPreset; isCustom: boolean };
  const presetOptions: PresetOption[] = [
    ...PROVIDER_PRESETS.map((p) => ({
      label: '$(zap) ' + p.name,
      description: p.description,
      preset: p,
      isCustom: false,
    })),
    { label: '$(edit) 自定义 Provider', description: '手动输入所有配置', isCustom: true },
  ];

  const selectedPreset = await vscode.window.showQuickPick(presetOptions, {
    placeHolder: '选择预设或自定义 Provider',
  });
  if (!selectedPreset) {return;}

  let name: string;
  let baseUrl: string;
  let model: string | undefined;

  if (selectedPreset.preset) {
    // 使用预设
    const preset = selectedPreset.preset;
    name = preset.name;
    baseUrl = preset.baseUrl;
    model = preset.model;
  } else {
    // 自定义流程
    const inputName = await vscode.window.showInputBox({
      prompt: 'Provider 名称',
      placeHolder: '例如：SiliconFlow、OpenRouter',
      validateInput: (v) => {
        if (!v?.trim()) {return '名称不能为空';}
        const config = loadConfig();
        if (config.apiProviders?.find((p) => p.name === v)) {return '该名称已存在';}
        return null;
      },
    });
    if (!inputName) {return;}
    name = inputName;

    const inputBaseUrl = await vscode.window.showInputBox({
      prompt: 'API Base URL（Anthropic 兼容端点）',
      placeHolder: '例如：https://api.siliconflow.cn/v1',
      validateInput: (v) => {
        if (!v?.trim()) {return 'URL 不能为空';}
        if (!v.startsWith('http')) {return '必须是有效的 URL';}
        return null;
      },
    });
    if (!inputBaseUrl) {return;}
    baseUrl = inputBaseUrl;

    const inputModel = await vscode.window.showInputBox({
      prompt: '模型名称（可选，留空使用默认）',
      placeHolder: '例如：claude-sonnet-4-20250514',
    });
    model = inputModel || undefined;
  }

  const apiKey = await vscode.window.showInputBox({
    prompt: `${name} API Key`,
    placeHolder: 'sk-...',
    password: true,
    validateInput: (v) => {
      if (!v?.trim()) {return 'API Key 不能为空';}
      return null;
    },
  });
  if (!apiKey) {return;}

  const config = loadConfig();
  config.apiProviders = config.apiProviders || [];
  config.apiProviders.push({ name, baseUrl, apiKey, model: model || undefined });
  saveConfig(config);

  vscode.window.showInformationMessage(`API Provider "${name}" 已添加`);
  accountTreeProvider?.refresh();
}

// ─── 命令：切换到 API Provider ─────────────────────────────────────────────────

async function commandSwitchApiProvider(): Promise<void> {
  const config = loadConfig();
  if (!config.apiProviders?.length) {
    const action = await vscode.window.showInformationMessage(
      '还没有添加任何 API Provider',
      '添加 Provider'
    );
    if (action) {await commandAddApiProvider();}
    return;
  }

  const current = config.currentApiProvider;
  const items = config.apiProviders.map((p) => ({
    label: (p.name === current ? '$(check) ' : '$(server) ') + p.name,
    description: p.baseUrl,
    detail: p.model ? `Model: ${p.model}` : '默认模型',
    providerName: p.name,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: '选择 API Provider',
  });

  if (!selected || selected.providerName === current) {return;}

  try {
    switchToApiProvider(selected.providerName);
    refreshStatusBar();
    const action = await vscode.window.showInformationMessage(
      `已切换到 "${selected.providerName}"，重载窗口后生效`,
      '立即重载'
    );
    if (action === '立即重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`切换失败: ${message}`);
  }
}

// ─── 命令：删除 API Provider ───────────────────────────────────────────────────

async function commandRemoveApiProvider(): Promise<void> {
  const config = loadConfig();
  if (!config.apiProviders?.length) {
    vscode.window.showInformationMessage('没有可删除的 API Provider');
    return;
  }

  const items = config.apiProviders.map((p) => ({
    label: '$(server) ' + p.name,
    description: p.baseUrl,
    providerName: p.name,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: '选择要删除的 API Provider',
  });
  if (!selected) {return;}

  const confirm = await vscode.window.showWarningMessage(
    `确定删除 "${selected.providerName}"？`,
    { modal: true },
    '删除'
  );
  if (confirm !== '删除') {return;}

  config.apiProviders = config.apiProviders.filter((p) => p.name !== selected.providerName);
  if (config.currentApiProvider === selected.providerName) {
    config.currentApiProvider = undefined;
    clearApiProviderSettings();
  }
  saveConfig(config);

  vscode.window.showInformationMessage(`API Provider "${selected.providerName}" 已删除`);
  refreshStatusBar();
}

// ─── 扩展入口 ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  ensureCurrentUsageAttribution();

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'claude-switcher.switch';
  context.subscriptions.push(statusBar);

  accountTreeProvider = new ClaudeAccountsTreeProvider();
  accountStatusProvider = new ClaudeStatusTreeProvider();
  context.subscriptions.push(
    vscode.window.createTreeView('claude-switcher.accountsView', {
      treeDataProvider: accountTreeProvider,
      showCollapseAll: false,
    }),
    vscode.window.createTreeView('claude-switcher.statusView', {
      treeDataProvider: accountStatusProvider,
      showCollapseAll: false,
    })
  );
  accountTreeProvider.refresh();
  accountStatusProvider.refresh();

  refreshStatusBar();
  autoRefreshTimer = setInterval(() => {
    refreshManagerData(false);
  }, AUTO_REFRESH_INTERVAL_MS);
  context.subscriptions.push({
    dispose: () => {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = undefined;
      }
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-switcher.switch', commandSwitch),
    vscode.commands.registerCommand('claude-switcher.add', commandAdd),
    vscode.commands.registerCommand('claude-switcher.remove', commandRemove),
    vscode.commands.registerCommand('claude-switcher.whoami', commandWhoami),
    vscode.commands.registerCommand('claude-switcher.usage', commandUsage),
    vscode.commands.registerCommand('claude-switcher.addProvider', commandAddApiProvider),
    vscode.commands.registerCommand('claude-switcher.switchProvider', commandSwitchApiProvider),
    vscode.commands.registerCommand('claude-switcher.removeProvider', commandRemoveApiProvider),
    vscode.commands.registerCommand('claude-switcher.refresh', () => {
      refreshManagerData(true);
      refreshStatusBar();
    }),
    vscode.commands.registerCommand('claude-switcher.switchToAccount', commandSwitchToAccount),
    vscode.commands.registerCommand('claude-switcher.switchToProvider', commandSwitchToProvider),
    vscode.commands.registerCommand('claude-switcher.removeAccountNode', commandRemoveAccountNode),
    vscode.commands.registerCommand('claude-switcher.renameAccountNode', commandRenameAccountNode)
  );
}

export function deactivate(): void {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
  }
  statusBar?.dispose();
  usagePanel?.dispose();
}
