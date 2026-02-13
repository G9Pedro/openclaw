import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "./registry.js";
import { createHookRunner } from "./hooks.js";

function createRegistryWithAutonomyHooks(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [
      {
        pluginId: "plugin-a",
        hookName: "autonomy_signal",
        priority: 5,
        source: "test",
        handler: async () => ({
          events: [
            {
              source: "manual",
              type: "plugin.a.signal",
              dedupeKey: "a",
            },
          ],
        }),
      },
      {
        pluginId: "plugin-b",
        hookName: "autonomy_signal",
        priority: 1,
        source: "test",
        handler: async () => ({
          events: [
            {
              source: "manual",
              type: "plugin.b.signal",
              dedupeKey: "b",
            },
          ],
        }),
      },
    ],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

describe("plugin hook runner autonomy_signal", () => {
  it("merges autonomy signal events from multiple hooks", async () => {
    const runner = createHookRunner(createRegistryWithAutonomyHooks(), {
      catchErrors: false,
    });
    const result = await runner.runAutonomySignal(
      {
        events: [
          {
            source: "manual",
            type: "base.signal",
            ts: Date.now(),
          },
        ],
      },
      {
        agentId: "ops",
        workspaceDir: "/tmp/workspace",
        stage: "discover",
        nowMs: Date.now(),
      },
    );
    expect(result?.events?.map((event) => event.type)).toEqual([
      "plugin.a.signal",
      "plugin.b.signal",
    ]);
  });
});
