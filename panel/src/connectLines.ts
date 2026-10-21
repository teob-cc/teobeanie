// connectLines.ts — what the Connect page tells an owner to paste: the agent port's URL
// from the address the browser uses for Home Assistant, the `claude mcp add` line, and
// the same as JSON for other MCP clients.

/** The MCP URL on the agent port: the browser's host for Home Assistant, plain HTTP. */
export function mcpUrl(hostname: string, port: number): string {
  // An IPv6 literal goes in brackets (most browsers keep them in location.hostname).
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `http://${host}:${port}/mcp`;
}

/** The line for Claude Code. */
export function claudeLine(url: string, token: string): string {
  return `claude mcp add --transport http teobeanie ${url} --header "Authorization: Bearer ${token}"`;
}

/** The same server for any MCP client that reads an `mcpServers` JSON. */
export function jsonSnippet(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { teobeanie: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}
