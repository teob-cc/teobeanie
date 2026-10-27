import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MCP_NETWORKS } from "./mcp/access.js";

/** User-facing options, set via the add-on Configuration tab (or env vars in standalone mode). */
export interface AddonOptions {
  llm_provider: "none" | "openrouter" | "ollama";
  openrouter_api_key: string;
  openrouter_model: string;
  ollama_url: string;
  llm_monthly_budget_usd: number;
  /** Speech to text for voice messages (an OpenAI-compatible transcription server); empty: the Teobeanie Whisper add-on. */
  stt_url: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
  /** A second chat for watching the house: notices of instances marked "alerts" go there too. */
  telegram_alerts_chat_id: string;
  /** Take bot commands from the chat (only one client may poll a bot: switch on at the cut-over). */
  telegram_commands: boolean;
  /** Post problems (HA down, refused or failed actions, a heuristic throwing, another automation on Teobeanie's entities) to the chat. */
  monitor_alerts: boolean;
  /** "HH:MM" local time of a daily summary in the chat; empty: none. */
  monitor_summary_time: string;
  /** Minutes Home Assistant may be unreachable before the chat is told. */
  monitor_ha_down_min: number;
  /** The house's IANA time zone, overriding Home Assistant's; empty: HA's. */
  time_zone: string;
  signal_retention_days: number;
  /** CIDRs MCP clients may reach the tools from through ingress (LAN and tailnet by default; empty: MCP over ingress closed). The agent port is token-only. */
  mcp_networks: string[];
  shadow_mode: boolean;
  log_level: "debug" | "info" | "warning" | "error";
}

export interface AppConfig {
  /** "addon" when running under the HA Supervisor, "standalone" for dev / HA Container users. */
  mode: "addon" | "standalone";
  haWsUrl: string;
  haToken: string;
  /** Databases (journal, signals, views). Add-on: /data, in every HA backup. */
  dataDir: string;
  /**
   * User-edited config (heuristics.json, allowlist.json). Add-on: /config, the
   * addon_config mount, visible as addon_configs/<slug> in Samba / Studio Code Server.
   */
  configDir: string;
  options: AddonOptions;
}

const DEFAULT_OPTIONS: AddonOptions = {
  llm_provider: "none",
  openrouter_api_key: "",
  openrouter_model: "anthropic/claude-sonnet-4.5",
  ollama_url: "",
  llm_monthly_budget_usd: 10,
  stt_url: "",
  telegram_bot_token: "",
  telegram_chat_id: "",
  telegram_alerts_chat_id: "",
  telegram_commands: false,
  monitor_alerts: true,
  monitor_summary_time: "",
  monitor_ha_down_min: 5,
  time_zone: "",
  signal_retention_days: 30,
  mcp_networks: [...DEFAULT_MCP_NETWORKS],
  shadow_mode: false,
  log_level: "info",
};

export function loadConfig(): AppConfig {
  const supervisorToken = process.env.SUPERVISOR_TOKEN;

  if (supervisorToken) {
    const options = existsSync("/data/options.json")
      ? { ...DEFAULT_OPTIONS, ...JSON.parse(readFileSync("/data/options.json", "utf8")) }
      : DEFAULT_OPTIONS;
    return {
      mode: "addon",
      haWsUrl: "ws://supervisor/core/websocket",
      haToken: supervisorToken,
      dataDir: "/data",
      configDir: "/config",
      options,
    };
  }

  const haWsUrl = process.env.HA_WS_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haWsUrl || !haToken) {
    throw new Error(
      "Standalone mode requires HA_WS_URL (e.g. ws://homeassistant.local:8123/api/websocket) " +
        "and HA_TOKEN (a long-lived access token) environment variables.",
    );
  }
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), ".dev-data");
  mkdirSync(dataDir, { recursive: true });
  return {
    mode: "standalone",
    haWsUrl,
    haToken,
    dataDir,
    configDir: process.env.CONFIG_DIR ?? dataDir,
    options: { ...DEFAULT_OPTIONS, shadow_mode: true },
  };
}
