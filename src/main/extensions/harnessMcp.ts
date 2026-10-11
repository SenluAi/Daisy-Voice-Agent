import yaml from "js-yaml";
import { isDeepStrictEqual } from "node:util";
import { McpManager, validate, type McpConfig, type McpServerConfig } from "./mcp";

export const MCP_PACKAGE = "@deepseek-ai/dsh-mcp-client";
export interface HarnessMcpEntry { id: string; name: string; disabled: boolean; config: Record<string, unknown>; state: number }

export function mcpPatch(config: McpConfig): string {
  return yaml.dump(Object.entries(config.mcpServers).map(([id, settings]) => ({ insert: [{
    id, name: MCP_PACKAGE, disabled: !!settings.disabled,
    config: { ...settings, disabled: undefined, serverName: settings.serverName || id,
      transport: settings.transport === "stdio" || settings.command ? "stdio" : "streamable-http" },
  }] })), { skipInvalid: true, noRefs: true });
}

export function parseMcpPatch(content: string): McpConfig {
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("MCP patch exceeds size limit");
  const rows = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  if (!Array.isArray(rows)) throw new Error("MCP patch must contain an entry array");
  const servers: Record<string, McpServerConfig> = Object.create(null);
  for (const row of rows) {
    for (const entry of Array.isArray(row?.insert) ? row.insert : [row]) {
      if (!entry || entry.name !== MCP_PACKAGE || typeof entry.id !== "string" || servers[entry.id]) throw new Error("Invalid or duplicate MCP patch entry");
      servers[entry.id] = { ...entry.config, disabled: !!entry.disabled };
    }
  }
  return validate(JSON.stringify({ mcpServers: servers }));
}

export function applyMcpPatch(source: string, patch: string): McpConfig {
  const current = validate(source);
  const baseline = parseMcpPatch(mcpPatch(current));
  const next = parseMcpPatch(patch);
  // The DSH UI materializes defaults. Keep untouched Daisy server definitions as-is.
  for (const [id, settings] of Object.entries(next.mcpServers)) {
    if (isDeepStrictEqual(settings, baseline.mcpServers[id])) next.mcpServers[id] = current.mcpServers[id];
  }
  return next;
}

export function harnessMcpSnapshot(manager: McpManager): { source: string; patch: string; entries: HarnessMcpEntry[]; schemas: { name: string }[] } {
  const source = manager.readConfig();
  const config = validate(source);
  const statuses = manager.snapshot();
  return { source, patch: mcpPatch(config), entries: Object.entries(config.mcpServers).map(([id, settings]) => {
    const status = statuses.find(x => x.id === id)?.status;
    return { id, name: MCP_PACKAGE, disabled: !!settings.disabled,
      config: { ...settings, serverName: settings.serverName || id,
        transport: settings.command ? "stdio" : "streamable-http" },
      state: status === "connected" ? 2 : status === "error" ? 3 : status === "disabled" ? 4 : 1 };
  }), schemas: manager.listTools().map(tool => {
    const id = statuses.find(x => tool.id.startsWith(`mcp:${x.id}:`))?.id || "";
    return { name: `mcp__${config.mcpServers[id]?.serverName || id}__${tool.name}` };
  }) };
}
