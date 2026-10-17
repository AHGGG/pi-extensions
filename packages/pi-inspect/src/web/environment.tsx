import { Badge, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { useState } from "react";
import type { Snapshot } from "../model.js";
import { Data } from "./components.js";
import { NavigationTabs } from "./navigation-tabs.js";

export type ResourceTab = "tools" | "mcp" | "skills";
const resources = [
  { value: "tools", label: "Tools" },
  { value: "mcp", label: "MCP Servers" },
  { value: "skills", label: "Skills" },
] as const;

export function Environment({ snapshot }: { snapshot?: Snapshot }) {
  const [tab, setTab] = useState<ResourceTab>("tools");
  // Visit panels once to retain scroll/disclosure state, without mounting unseen catalogs.
  const [visited, setVisited] = useState<ReadonlySet<ResourceTab>>(() => new Set(["tools"]));
  function select(value: ResourceTab) {
    setTab(value);
    setVisited((old) => new Set([...old, value]));
  }
  return (
    <>
      <div className="environment-heading">
        <Heading size="4">Environment</Heading>
        <Text as="p" size="2" color="gray">
          Current resource information · not historical request evidence.
        </Text>
        {!snapshot && <p role="status">Resource inventory unavailable until a snapshot loads.</p>}
        {snapshot?.incomplete && <p role="status">Snapshot incomplete; resource catalogs may be partial.</p>}
      </div>
      <NavigationTabs id="resource" label="Environment resources" tabs={resources} value={tab} change={select} />
      {resources.map(({ value, label }) => (
        <section
          key={value}
          role="tabpanel"
          id={`resource-panel-${value}`}
          aria-labelledby={`resource-tab-${value}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Read-only resource panels need keyboard focus for scrolling.
          tabIndex={0}
          className="resource-panel"
          hidden={tab !== value}
        >
          {visited.has(value) && (
            <>
              <Heading size="3">{label}</Heading>
              {value === "tools" && (
                <>
                  <p>Current active ≠ provider-visible. Source metadata does not prove MCP server ownership.</p>
                  {snapshot && !snapshot.tools.length && <p>No tools in this snapshot.</p>}
                  {snapshot?.tools.map((tool, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Bounded display names and paths can collide; position distinguishes catalog records.
                    <Card key={`${index}-${tool.name}`} className="inventory-card">
                      <Heading size="2">{tool.name}</Heading>
                      <Flex gap="1" wrap="wrap">
                        <Badge>{tool.namespace ?? "Namespace unavailable"}</Badge>
                        <Badge>{tool.exposure}</Badge>
                        <Badge>{tool.active ? "active" : "inactive"}</Badge>
                        <Badge>{tool.callable ? "callable" : "not callable"}</Badge>
                      </Flex>
                      <p>{tool.description}</p>
                      {tool.metadataTruncated && <p>Tool metadata truncated.</p>}
                      <Data label={`Source · ${tool.name}`} data={tool.source} defaultOpen={false} />
                      <Data label={`Schema · ${tool.name}`} data={tool.schema} defaultOpen={false} />
                    </Card>
                  ))}
                </>
              )}
              {value === "mcp" && (
                <>
                  <p>Extension registrations only; the complete configured server catalog is unavailable.</p>
                  <p>
                    Connection/authentication status and authoritative server-to-tool associations are unavailable. A
                    registration is not a connection.
                  </p>
                  {snapshot && (!snapshot.mcp || snapshot.mcp.unavailable) && (
                    <p role="status">MCP registration API unavailable.</p>
                  )}
                  {snapshot?.mcp && !snapshot.mcp.unavailable && !snapshot.mcp.servers.length && (
                    <p>No extension registrations reported. This does not mean no MCP servers exist.</p>
                  )}
                  {snapshot?.mcp?.truncated && <p role="status">MCP registration catalog truncated to 256 servers.</p>}
                  {snapshot?.mcp?.servers.map((server, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Bounded display names can collide; position distinguishes catalog records.
                    <Card key={`${index}-${server.name}`} className="inventory-card">
                      <Heading size="2">{server.name}</Heading>
                      <Badge>extension registration</Badge>
                      <p>
                        Connection status: unavailable. Tools: ownership unavailable; inspect the Tools tab for
                        namespace metadata.
                      </p>
                      {server.truncated && <p>Server name truncated.</p>}
                    </Card>
                  ))}
                </>
              )}
              {value === "skills" && (
                <>
                  <p>
                    Catalog captured when the inspector started; not continuously refreshed. Paths are source evidence,
                    not verified file availability.
                  </p>
                  <p>
                    Skill content unavailable: file contents are not captured or read. Advertised or read does not prove
                    model compliance.
                  </p>
                  {snapshot && <p>Inspector capture started: {new Date(snapshot.captureStartedAt).toISOString()}</p>}
                  {snapshot && !snapshot.skills.length && <p>No skills in the startup catalog.</p>}
                  {snapshot?.skills.map((skill, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Bounded paths can collide; position distinguishes catalog records.
                    <Card key={`${index}-${skill.path}`} className="inventory-card">
                      <Heading size="2">{skill.name}</Heading>
                      <Badge>startup catalog</Badge>
                      <p>{skill.description}</p>
                      <Data
                        label={`Path · ${skill.name}`}
                        data={{ value: skill.path, truncated: Boolean(skill.pathTruncated) }}
                        defaultOpen={false}
                      />
                      {skill.metadataTruncated && <p>Skill metadata truncated.</p>}
                    </Card>
                  ))}
                </>
              )}
            </>
          )}
        </section>
      ))}
    </>
  );
}
