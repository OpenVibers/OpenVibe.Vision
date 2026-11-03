'use strict';
// What OpenVibe.Vision tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json (SEO-2).
// Every field is something this site really serves; the purpose is its own llms.txt summary.
module.exports = {
    id: "vision",
    name: "OpenVibe.Vision",
    purpose: "Answers questions about a picture, reads text locally and checks UI faults. Face features that identify a person each need that person's consent.",
    home: "https://openvibe.vision",
    site: "openvibe.vision",
    api: "/api/v1",
    docs: "/developers",
    mcp: { url: "/mcp" },
    policy: {
        auth: ["none", "Network OIDC"],
    },
};
