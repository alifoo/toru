export type Client = "claude-code" | "claude" | "cursor" | "codex" | "other";
export type ClientSetup = { title: string; icon: string; steps: Array<{ text: string; code?: string }>; clip?: string };
/** Install steps per agent, shared by onboarding and the landing page. A clip shows up in "Watch how" once public/onboarding/<client>.mp4 exists. */
export const CLIENTS: Record<Client, ClientSetup> = {
  "claude-code": { icon: "/agents/claude-code.svg", title: "Claude Code", steps: [
    { text: "Add the Toru plugin marketplace.", code: "/plugin marketplace add alifoo/toru-skills" },
    { text: "Install the plugin.", code: "/plugin install toru@toru-skills" },
    { text: "Reload plugins so Toru is available.", code: "/reload-plugins" },
    { text: "Authorize Toru: type /plugin, open Installed → Toru, press Enter and sign in." },
  ] },
  claude: { icon: "/agents/claude.svg", title: "Claude", steps: [
    { text: "Open Settings → Connectors → Add custom connector." },
    { text: "Paste the Toru address.", code: "https://mcp.toru.tools/mcp" },
    { text: "Connect and sign in to Toru, then turn Toru on in a new chat." },
  ] },
  cursor: { icon: "/agents/cursor.svg", title: "Cursor", steps: [
    { text: "Install the Toru skill.", code: "npx skills add alifoo/toru-skills" },
    { text: "Or add Toru as an MCP server in Cursor settings.", code: "https://mcp.toru.tools/mcp" },
    { text: "Sign in to Toru when Cursor asks." },
  ] },
  codex: { icon: "/agents/codex.svg", title: "Codex", steps: [
    { text: "Add the Toru marketplace.", code: "codex plugin marketplace add alifoo/toru-skills" },
    { text: "Install Toru from the Codex plugin directory." },
    { text: "Sign in to Toru when Codex asks." },
  ] },
  other: { icon: "/agents/mcp.svg", title: "Other", steps: [
    { text: "Add Toru as a remote HTTP MCP server with OAuth.", code: "https://mcp.toru.tools/mcp" },
    { text: "No OAuth in your client? Create a token later under Connections → Advanced." },
  ] },
};
