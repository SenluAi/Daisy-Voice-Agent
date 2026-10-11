export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  enabled: boolean;
  builtin?: boolean;
  status: "ready" | "disabled" | "error" | "requires_host";
  error?: string;
  panelAvailable?: boolean;
  toolCount?: number;
  dependencies?: { name: string; available: boolean; required: boolean }[];
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  source: "personal" | "plugin";
  readonly: boolean;
}

export interface McpEntry {
  id: string;
  enabled: boolean;
  status: "connected" | "connecting" | "disabled" | "error";
  toolCount: number;
  error?: string;
}

export interface ExtensionSnapshot {
  plugins: PluginEntry[];
  skills: SkillEntry[];
  mcpServers: McpEntry[];
  directory: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  stars: number;
  verified: boolean;
  repository?: string;
  npmPackage?: string;
  updatedAt?: string;
  webInstallable: boolean;
}

export interface CatalogQuery {
  search?: string;
  category?: string;
  sort?: "stars" | "updated";
  offset?: number;
  limit?: number;
  refresh?: boolean;
}

export interface CatalogResult {
  entries: CatalogEntry[];
  total: number;
  catalogTotal: number;
  verified: number;
  categories: string[];
  syncedAt: number;
  stale: boolean;
  error?: string;
}

export interface SkillDraft {
  id?: string;
  name: string;
  description: string;
  content: string;
}

export interface ExtensionRequests {
  snapshot: { input: undefined; output: ExtensionSnapshot };
  catalog: { input: CatalogQuery; output: CatalogResult };
  installPlugin: { input: { id: string }; output: ExtensionSnapshot };
  importPlugin: { input: undefined; output: ExtensionSnapshot };
  togglePlugin: { input: { id: string; enabled: boolean }; output: ExtensionSnapshot };
  deletePlugin: { input: { id: string }; output: ExtensionSnapshot };
  openPluginPanel: { input: { id: string }; output: ExtensionSnapshot };
  pluginConfig: { input: { id: string }; output: string };
  savePluginConfig: { input: { id: string; json: string }; output: ExtensionSnapshot };
  readSkill: { input: { id: string }; output: SkillDraft };
  saveSkill: { input: SkillDraft; output: ExtensionSnapshot };
  importSkill: { input: undefined; output: ExtensionSnapshot };
  toggleSkill: { input: { id: string; enabled: boolean }; output: ExtensionSnapshot };
  deleteSkill: { input: { id: string }; output: ExtensionSnapshot };
  mcpConfig: { input: undefined; output: string };
  saveMcpConfig: { input: { json: string }; output: ExtensionSnapshot };
}

export type ExtensionAction = keyof ExtensionRequests;
export type ExtensionRequestAPI = <K extends ExtensionAction>(
  action: K, input?: ExtensionRequests[K]["input"]
) => Promise<ExtensionRequests[K]["output"]>;
