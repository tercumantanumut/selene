export {
  DARIO_BASE_URL_PATH,
  DARIO_DEFAULT_PORT,
  DARIO_HOST,
  darioAuthHeaders,
  ensureDarioConfig,
  getDarioBaseUrl,
  getDarioOrigin,
  getSeleneDarioDir,
  type DarioConfigFile,
} from "./config";

export {
  ensureDarioSidecarReady,
  isDarioSidecarReady,
  stopDarioSidecar,
  type DarioSidecarReady,
} from "./sidecar";

export {
  DarioStatusError,
  fetchDarioStatus,
  isDarioStatusUsable,
  type DarioOAuthStatus,
  type DarioStatus,
} from "./status";

export {
  awaitClaudeLoginCompletion,
  getClaudeLoginState,
  killClaudeLogin,
  logoutClaudeLogin,
  refreshClaudeLogin,
  startClaudeLogin,
  submitClaudeLoginCode,
  type LoginStart,
  type LoginState,
  type LoginStatus,
} from "./login";
