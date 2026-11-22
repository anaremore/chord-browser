// S19: the lockdown a Chord-driven `agy acp` session would need, as pure
// functions (docs/decisions/S19-antigravity-assistant.md). The spike's
// session driver and its self-test both use them. Not wired into the app.

/** Chord's MCP server name in `session/new`. agy names its tools `mcp_<server>_<tool>`. */
export const SERVER = 'chord';

/** Sign-in methods the assistant may use. Never `oauth-personal` (Google's FAQ: no wrapping on consumer plans). */
export const ALLOWED_AUTH = ['gemini-api-key', 'oauth-business', 'agent-platform'];

/** The newest agy checked here. */
export const TESTED_VERSION = '1.5.14';

/**
 * Private settings for `<GEMINI_HOME>/antigravity-acp/settings.json`.
 * `toolPermission: "strict"` is what made agy ask before every file write and
 * edit (in `default` mode a workspace write never asks). The deny rules
 * changed nothing in 1.5.14 (S19 run r9) and are kept only as a second word.
 */
export function privateSettings(authType) {
  if (!ALLOWED_AUTH.includes(authType)) throw new Error(`Sign-in method not allowed: ${authType}`);
  return {
    auth: { type: authType },
    toolPermission: 'strict',
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
    permissions: {
      deny: ['read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)'],
    },
  };
}

/** Variables never passed to agy from Chord's own environment: Google credentials and agy's own switches. */
const DROPPED = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'AGY_ADC_AUTH',
  'GEMINI_HOME',
  'AGY_ACP_FORCE_FILE_STORAGE',
  'AGY_CLI_DISABLE_AUTO_UPDATE',
  'GOOGLE_GEMINI_BASE_URL',
  'BROWSER',
  'ELECTRON_RUN_AS_NODE',
  'SSH_CONNECTION',
]);

/** agy's environment: the user's, minus the above, plus a private home. Windows keys are case-insensitive. */
export function agyEnv(base, { geminiHome, tempDir }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!DROPPED.has(k.toUpperCase())) env[k] = v;
  return {
    ...env,
    GEMINI_HOME: geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    ...(process.platform === 'win32' ? { TEMP: tempDir, TMP: tempDir } : { TMPDIR: tempDir }),
  };
}

export function agyArgs(geminiHome) {
  return ['acp', '--gemini-dir', geminiHome, '--app-data-dir', 'antigravity-acp', '--disable-telemetry', '--sandbox'];
}

/** Chord's own tool, as agy names it: `mcp_chord_<name>` for a name Chord offered. */
export function chordTool(name, offered) {
  const prefix = `mcp_${SERVER}_`;
  if (typeof name !== 'string' || !name.startsWith(prefix)) return null;
  const tool = name.slice(prefix.length);
  return offered.includes(tool) ? tool : null;
}

/**
 * The answer to `session/request_permission`: allow once for Chord's own tools
 * (Chord's gate then asks the user where its rules say so), reject everything
 * else. Never `allow_always`: a grant agy remembers is a grant Chord can't see.
 */
export function permissionAnswer(params, offered) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const ours = chordTool(params?.toolCall?.name ?? params?.toolCall?.title?.replace(/^Run /, ''), offered) !== null;
  const want = ours ? 'allow_once' : 'reject_once';
  const option = options.find((o) => o.kind === want) ?? (ours ? null : options.find((o) => o.kind === 'reject_always'));
  return {
    allow: ours && !!option,
    outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' },
  };
}

/**
 * Codex's tripwire, for agy: a tool call that isn't one of Chord's stops the
 * turn. Some run without asking whatever the settings (`search_web`,
 * `schedule`, `invoke_subagent`, `define_subagent`, `ask_question`,
 * `manage_task`), so this is the only check they meet, and it comes after
 * they started.
 */
export function trips(update, offered) {
  if (update?.sessionUpdate !== 'tool_call') return false;
  return chordTool(update.name ?? update.title?.replace(/^Run /, ''), offered) === null;
}

/** Anything from agy while no prompt is running (a `schedule` timer firing, a subagent finishing) is a tripwire too. */
export function outOfTurn(message, promptRunning) {
  return !promptRunning && message?.method === 'session/update' && message.params?.update?.sessionUpdate === 'tool_call';
}

/** Checks `initialize`: the server Chord tested, and that no method is forced on Chord. */
export function checkInitialize(result) {
  const methods = (result?.authMethods ?? []).map((m) => m.id);
  return {
    name: result?.agentInfo?.name ?? null,
    version: result?.agentInfo?.version ?? null,
    offersAllowed: ALLOWED_AUTH.filter((m) => methods.includes(m)),
    http: !!result?.agentCapabilities?.mcpCapabilities?.http,
  };
}
