import { test } from "node:test";
import { strict as assert } from "node:assert";
import { HaproxyManager } from "../HaproxyManager.js";
import {
  DEFAULT_HAPROXY_SETTINGS,
  normalizeHaproxySettings,
} from "../../settings.js";
import { buildOpencodeConfig } from "../../opencodeConfig.js";

function snapshot(overrides = {}) {
  return {
    id: "lambda",
    name: "Lambda — Ornith",
    online: true,
    lanIp: "10.1.1.100",
    llmPort: 11434,
    llmPorts: [11434],
    metrics: {
      llm: [{ available: true, port: 11434, modelId: "ornith:35b", contextLength: 65536 }],
    },
    ...overrides,
  };
}

test("normalizeHaproxySettings clamps unsafe fields and duplicate mappings", () => {
  const settings = normalizeHaproxySettings({
    enabled: true,
    domain: " OAI.MHPS.DEV ",
    remoteDockerHost: "lambda; reboot",
    sshPort: 70000,
    sshUser: "root;id",
    sshAuth: "password",
    containerName: "ai-haproxy$(id)",
    mainConfigPath: "/etc/../passwd",
    backendMappings: [
      { name: "Lambda", port: 8001, enabled: true },
      { name: "lambda", port: 9001, enabled: true },
      { name: "GX10A", port: 8001, enabled: true },
      { name: "GX10B", port: 8003, enabled: false, ignored: "field" },
    ],
  });

  assert.equal(settings.enabled, true);
  assert.equal(settings.domain, "oai.mhps.dev");
  assert.equal(settings.remoteDockerHost, DEFAULT_HAPROXY_SETTINGS.remoteDockerHost);
  assert.equal(settings.sshPort, 22);
  assert.equal(settings.sshUser, "root");
  assert.equal(settings.sshAuth, "key");
  assert.equal(settings.containerName, "ai-haproxy");
  assert.equal(settings.mainConfigPath, DEFAULT_HAPROXY_SETTINGS.mainConfigPath);
  assert.deepEqual(settings.backendMappings, [
    { name: "Lambda", port: 8001, enabled: true },
    { name: "GX10B", port: 8003, enabled: false },
  ]);
});

test("preview emits only live mapped backends and no untrusted settings", () => {
  const manager = new HaproxyManager({
    getConfig: () => ({
      ...DEFAULT_HAPROXY_SETTINGS,
      enabled: true,
      backendMappings: [
        { name: "Lambda", port: 8001, enabled: true },
        { name: "GX10A", port: 8002, enabled: true },
      ],
    }),
    getSparks: () => [snapshot()],
  });

  const preview = manager.preview();
  assert.equal(preview.active.length, 1);
  assert.equal(preview.active[0].publicPort, 8001);
  assert.match(
    preview.content,
    /bind :8001 ssl crt \/usr\/local\/etc\/haproxy\/certs alpn h2,http\/1\.1/
  );
  assert.match(preview.content, /server lambda 10\.1\.1\.100:11434/);
  assert.doesNotMatch(preview.content, /bind :8002/);
  assert.deepEqual(preview.skipped, [{ name: "GX10A", reason: "no live LLM endpoint" }]);
});

test("OpenCode export uses HAProxy only for enabled mapped endpoints", () => {
  const direct = buildOpencodeConfig([snapshot()]);
  const proxied = buildOpencodeConfig([snapshot()], {
    enabled: true,
    exportEnabled: true,
    domain: "oai.mhps.dev",
    backendMappings: [{ name: "Lambda", port: 8001, enabled: true }],
  });
  const directProvider = Object.values(direct.provider)[0];
  const proxyProvider = Object.values(proxied.provider)[0];
  assert.equal(directProvider.options.baseURL, "http://10.1.1.100:11434/v1");
  assert.equal(proxyProvider.options.baseURL, "https://oai.mhps.dev:8001/v1");
});
