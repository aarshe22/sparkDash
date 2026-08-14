import { test } from "node:test";
import { strict as assert } from "node:assert";
import { HaproxyManager } from "../HaproxyManager.js";
import {
  DEFAULT_HAPROXY_SETTINGS,
  normalizeHaproxySettings,
} from "../../settings.js";
import { buildGrokConfigToml, buildOpencodeConfig } from "../../opencodeConfig.js";

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

test("endpoint-specific mappings independently target multiple LLM ports", () => {
  const spark = snapshot({
    llmPort: 11434,
    llmPorts: [11434, 8888],
    metrics: {
      llm: [
        { available: true, port: 11434, modelId: "primary", contextLength: 32768 },
        { available: true, port: 8888, modelId: "secondary", contextLength: 65536 },
      ],
    },
  });
  const mappings = [
    { name: "Lambda", port: 8001, enabled: true },
    { name: "lambda_8888", port: 8011, enabled: true, sparkId: "lambda", llmPort: 8888 },
  ];
  const manager = new HaproxyManager({
    getConfig: () => ({
      ...DEFAULT_HAPROXY_SETTINGS,
      enabled: true,
      backendMappings: mappings,
    }),
    getSparks: () => [spark],
  });

  const preview = manager.preview();
  assert.deepEqual(
    preview.active.map(({ publicPort, targetPort }) => ({ publicPort, targetPort })),
    [
      { publicPort: 8001, targetPort: 11434 },
      { publicPort: 8011, targetPort: 8888 },
    ]
  );

  const haproxy = {
    enabled: true,
    exportEnabled: true,
    domain: "oai.mhps.dev",
    backendMappings: mappings,
  };
  const config = buildOpencodeConfig([spark], haproxy);
  assert.equal(
    config.provider["sparkdash-lambda-11434"].options.baseURL,
    "https://oai.mhps.dev:8001/v1"
  );
  assert.equal(
    config.provider["sparkdash-lambda-8888"].options.baseURL,
    "https://oai.mhps.dev:8011/v1"
  );
  const toml = buildGrokConfigToml([spark], haproxy);
  assert.match(toml, /base_url = "https:\/\/oai\.mhps\.dev:8001\/v1"/);
  assert.match(toml, /base_url = "https:\/\/oai\.mhps\.dev:8011\/v1"/);
});

test("normalization preserves stable targets and rejects duplicate enabled public ports", () => {
  const settings = normalizeHaproxySettings({
    backendMappings: [
      { name: "one", port: 9000, enabled: true, sparkId: "lambda", llmPort: 11434 },
      { name: "two", port: 9000, enabled: true, sparkId: "lambda", llmPort: 8888 },
      { name: "three", port: 9000, enabled: false, sparkId: "gx10a", llmPort: 8888 },
    ],
  });
  assert.deepEqual(settings.backendMappings, [
    { name: "one", port: 9000, enabled: true, sparkId: "lambda", llmPort: 11434 },
    { name: "three", port: 9000, enabled: false, sparkId: "gx10a", llmPort: 8888 },
  ]);
});

test("sync hash is stable across generation times and changes with endpoint mappings", () => {
  let generatedAt = "2026-08-14T12:00:00.000Z";
  let publicPort = 8001;
  const manager = new HaproxyManager({
    getConfig: () => ({
      ...DEFAULT_HAPROXY_SETTINGS,
      enabled: true,
      backendMappings: [{ name: "Lambda", port: publicPort, enabled: true }],
    }),
    getSparks: () => [snapshot()],
    now: () => generatedAt,
  });

  const first = manager.sync();
  generatedAt = "2026-08-14T12:01:00.000Z";
  const second = manager.sync();
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.equal(first.hash, second.hash);
  assert.notEqual(first.generatedAt, second.generatedAt);

  publicPort = 8011;
  assert.notEqual(manager.sync().hash, first.hash);
});

test("deploy rejects stale sync before any remote command", async () => {
  let remoteCalls = 0;
  const manager = new HaproxyManager({
    getConfig: () => ({
      ...DEFAULT_HAPROXY_SETTINGS,
      enabled: true,
      backendMappings: [{ name: "Lambda", port: 8001, enabled: true }],
    }),
    getSparks: () => [snapshot()],
    exec: async () => {
      remoteCalls += 1;
      throw new Error("remote command must not run");
    },
  });

  await assert.rejects(
    manager.deploy("0".repeat(64)),
    (error) => error.status === 409 && error.code === "STALE_SYNC"
  );
  assert.equal(remoteCalls, 0);
});

test("deploy validates and activates before restarting the container", async () => {
  const commands = [];
  const manager = new HaproxyManager({
    getConfig: () => ({
      ...DEFAULT_HAPROXY_SETTINGS,
      enabled: true,
      backendMappings: [{ name: "Lambda", port: 8001, enabled: true }],
    }),
    getSparks: () => [snapshot()],
    now: () => "2026-08-14T12:00:00.000Z",
    exec: async (_target, command) => {
      commands.push(command);
      if (command.includes("docker inspect") && command.includes(".Config.Cmd")) {
        return JSON.stringify([
          "haproxy",
          "-f",
          DEFAULT_HAPROXY_SETTINGS.mainConfigPath,
          "-f",
          DEFAULT_HAPROXY_SETTINGS.managedSnippetPath,
        ]);
      }
      if (command.includes("haproxy -c")) return "Configuration file is valid";
      if (command.includes("docker restart")) return DEFAULT_HAPROXY_SETTINGS.containerName;
      return "";
    },
  });

  const synced = manager.sync();
  const result = await manager.deploy(synced.hash);
  assert.deepEqual(result.diagnostics.steps, ["validated", "activated", "restarted"]);
  assert.match(commands[1], /haproxy -c/);
  assert.match(commands[1], /haproxy\.cfg/);
  assert.match(commands[1], /sparkdash\.tmp/);
  assert.match(commands[2], /mv -f .*sparkdash\.tmp/);
  assert.match(commands[3], /docker restart --time 30/);
});
