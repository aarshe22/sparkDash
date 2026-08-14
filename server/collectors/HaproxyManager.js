import crypto from "crypto";
import { sshExec } from "./ssh.js";
import { getHaproxyPassword } from "../secretsStore.js";
import { normalizeHaproxySettings } from "../settings.js";

const MAX_SNIPPET_BYTES = 128 * 1024;
const STATUS_TIMEOUT_MS = 12_000;
const HAPROXY_CERT_DIRECTORY = "/usr/local/etc/haproxy/certs";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function slug(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "backend"
  );
}

function identity(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function selectSpark(mapping, sparks) {
  const wanted = identity(mapping.sparkId || mapping.name);
  return (sparks || []).find((spark) => {
    const id = identity(spark?.id);
    const name = identity(spark?.name);
    return mapping.sparkId
      ? id === wanted
      : id === wanted || name === wanted || name.startsWith(wanted);
  });
}

function selectLlmPort(mapping, spark) {
  const llms = Array.isArray(spark?.metrics?.llm) ? spark.metrics.llm : [];
  if (mapping.llmPort) {
    const exact = llms.find(
      (llm) =>
        llm?.available &&
        llm.port === mapping.llmPort
    );
    return exact?.port ?? null;
  }
  const available = llms.find(
    (llm) => llm?.available && Number.isInteger(llm.port) && llm.port >= 1 && llm.port <= 65535
  );
  return available?.port ?? null;
}

function csvRows(text) {
  const lines = String(text || "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].replace(/^#\s*/, "").split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ""]));
  });
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentConfigHash(config, content, active, skipped) {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        version: 1,
        config,
        content,
        active,
        skipped,
      }),
      "utf8"
    )
    .digest("hex");
}

export class HaproxyManager {
  constructor({ getConfig, getSparks, exec = sshExec, now = () => new Date() }) {
    this.getConfig = getConfig;
    this.getSparks = getSparks;
    this.exec = exec;
    this.now = now;
    this._cachedStatus = this.disabledStatus();
    this._lastPollAt = 0;
    this._pollPromise = null;
  }

  config() {
    return normalizeHaproxySettings(this.getConfig?.());
  }

  remoteTarget(config = this.config()) {
    return {
      id: "haproxy",
      lanIp: config.remoteDockerHost,
      ssh: {
        host: config.remoteDockerHost,
        port: config.sshPort,
        user: config.sshUser,
        auth: config.sshAuth,
        password: config.sshAuth === "pass" ? getHaproxyPassword() : undefined,
      },
    };
  }

  disabledStatus() {
    return {
      enabled: false,
      online: false,
      containerStatus: "disabled",
      version: null,
      uptimeSeconds: null,
      connectionsCurrent: 0,
      sessionsTotal: 0,
      bytesIn: 0,
      bytesOut: 0,
      errorsTotal: 0,
      backends: [],
      checkedAt: Date.now(),
      error: null,
    };
  }

  sync(config = this.config()) {
    const sparks = this.getSparks?.() || [];
    const active = [];
    const skipped = [];
    const lines = [
      "# Managed by sparkDash. Manual edits will be replaced.",
      `# Domain: ${config.domain}`,
      "",
    ];

    for (const mapping of config.backendMappings) {
      if (!mapping.enabled) {
        skipped.push({ name: mapping.name, reason: "disabled" });
        continue;
      }
      const spark = selectSpark(mapping, sparks);
      const targetPort = selectLlmPort(mapping, spark);
      const targetHost = spark?.lanIp && String(spark.lanIp).trim();
      if (!spark || !spark.online || !targetHost || !targetPort) {
        skipped.push({ name: mapping.name, reason: "no live LLM endpoint" });
        continue;
      }
      if (!/^(?:[A-Za-z0-9.-]+|\d{1,3}(?:\.\d{1,3}){3})$/.test(targetHost)) {
        skipped.push({ name: mapping.name, reason: "invalid target host" });
        continue;
      }
      const id = slug(`${mapping.name}_${mapping.sparkId || ""}_${mapping.llmPort || ""}`);
      lines.push(`listen sparkdash_${id}`);
      // The managed public model ports are HTTPS. HAProxy accepts a directory
      // here and selects the matching SNI certificate for the configured domain.
      lines.push(`    bind :${mapping.port} ssl crt ${HAPROXY_CERT_DIRECTORY} alpn h2,http/1.1`);
      lines.push("    mode http");
      lines.push("    option httplog");
      lines.push(
        `    http-request set-var(txn.sparkdash_${id}_key_hash) req.hdr(authorization),sha2(256),hex,lower`
      );
      lines.push("    acl trusted_api_src src 10.1.0.0/16 172.16.196.0/24");
      lines.push(
        `    acl valid_sparkdash_${id}_key var(txn.sparkdash_${id}_key_hash) -m str -f /usr/local/etc/haproxy/herd-api-key-sha256.lst`
      );
      lines.push(
        `    http-request deny deny_status 401 if !trusted_api_src !valid_sparkdash_${id}_key`
      );
      lines.push("    http-request del-header Authorization");
      lines.push("    option httpchk GET /v1/models");
      lines.push("    http-check expect status 200");
      lines.push("    timeout connect 5s");
      lines.push("    timeout client 1h");
      lines.push("    timeout server 1h");
      lines.push(
        `    server ${id} ${targetHost}:${targetPort} check inter 3s fall 2 rise 2`
      );
      lines.push("");
      active.push({
        name: mapping.name,
        publicPort: mapping.port,
        sparkId: spark.id,
        targetHost,
        targetPort,
      });
    }

    const content = `${lines.join("\n").trimEnd()}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_SNIPPET_BYTES) {
      throw new Error("Generated HAProxy snippet exceeds the safe size limit");
    }
    return {
      content,
      active,
      skipped,
      domain: config.domain,
      hash: contentConfigHash(config, content, active, skipped),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  preview() {
    return this.sync();
  }

  async testConnection() {
    const output = await this.exec(
      this.remoteTarget(),
      `docker inspect --type container ${shellQuote(this.config().containerName)} --format '{{.State.Status}}'`,
      { timeoutMs: STATUS_TIMEOUT_MS }
    );
    return { ok: output === "running", containerStatus: output, message: output };
  }

  async effectiveConfigPaths(config = this.config()) {
    const commandJson = await this.exec(
      this.remoteTarget(config),
      `docker inspect --type container ${shellQuote(config.containerName)} --format '{{json .Config.Cmd}}'`,
      { timeoutMs: STATUS_TIMEOUT_MS }
    );
    let command;
    try {
      command = JSON.parse(commandJson);
    } catch {
      throw new Error("Could not parse the HAProxy container command");
    }
    const paths = [];
    if (Array.isArray(command)) {
      for (let index = 0; index < command.length - 1; index += 1) {
        if (command[index] === "-f" && typeof command[index + 1] === "string") {
          paths.push(command[index + 1]);
          index += 1;
        }
      }
    }
    if (!paths.includes(config.managedSnippetPath)) {
      throw new Error(
        `HAProxy container does not load ${config.managedSnippetPath}. ` +
          "Add it as a second -f config in the container command before applying."
      );
    }
    return paths;
  }

  async uploadAndValidate(content, config = this.config()) {
    if (typeof content !== "string" || !content || Buffer.byteLength(content) > MAX_SNIPPET_BYTES) {
      throw new Error("Invalid generated HAProxy snippet");
    }
    const effectivePaths = await this.effectiveConfigPaths(config);
    const nonce = crypto.randomBytes(8).toString("hex");
    const hostTemp = `/tmp/sparkdash-haproxy-${nonce}.b64`;
    const candidate = `${config.managedSnippetPath}.sparkdash.tmp`;
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const container = shellQuote(config.containerName);
    const command = [
      `umask 077`,
      `printf %s ${shellQuote(encoded)} > ${shellQuote(hostTemp)}`,
      `docker exec --user root ${container} mkdir -p ${shellQuote(config.managedSnippetPath.replace(/\/[^/]+$/, ""))}`,
      `base64 -d ${shellQuote(hostTemp)} > ${shellQuote(`${hostTemp}.cfg`)}`,
      `docker cp ${shellQuote(`${hostTemp}.cfg`)} ${shellQuote(`${config.containerName}:${candidate}`)}`,
      `docker exec --user root ${container} chmod 0644 ${shellQuote(candidate)}`,
      `rm -f ${shellQuote(hostTemp)} ${shellQuote(`${hostTemp}.cfg`)}`,
      `docker exec ${container} haproxy -c ${effectivePaths
        .map((path) => `-f ${shellQuote(path === config.managedSnippetPath ? candidate : path)}`)
        .join(" ")}`,
    ].join(" && ");
    try {
      const validation = await this.exec(this.remoteTarget(config), command, { timeoutMs: 20_000 });
      return { candidate, validation };
    } catch (error) {
      await this.exec(
        this.remoteTarget(config),
        `rm -f ${shellQuote(hostTemp)} ${shellQuote(`${hostTemp}.cfg`)}; docker exec ${container} rm -f ${shellQuote(candidate)}`,
        { timeoutMs: STATUS_TIMEOUT_MS }
      ).catch(() => {});
      throw error;
    }
  }

  async activate(candidate, config = this.config()) {
    if (candidate !== `${config.managedSnippetPath}.sparkdash.tmp`) {
      throw new Error("Candidate path does not match the managed HAProxy path");
    }
    const container = shellQuote(config.containerName);
    const managed = shellQuote(config.managedSnippetPath);
    const backup = shellQuote(`${config.managedSnippetPath}.sparkdash.bak`);
    const command =
      `docker exec --user root ${container} sh -eu -c ` +
      shellQuote(
        `if [ -f ${managed} ]; then cp -p ${managed} ${backup}; fi; ` +
          `mv -f ${shellQuote(candidate)} ${managed}`
      );
    await this.exec(this.remoteTarget(config), command, { timeoutMs: STATUS_TIMEOUT_MS });
  }

  async reload() {
    const config = this.config();
    const output = await this.exec(
      this.remoteTarget(),
      `docker kill --signal USR2 ${shellQuote(config.containerName)}`,
      { timeoutMs: STATUS_TIMEOUT_MS }
    );
    return { ok: true, container: output || config.containerName, signal: "USR2" };
  }

  async apply({ reload = true } = {}) {
    const preview = this.preview();
    if (preview.active.length === 0) {
      throw new Error("Refusing to apply an HAProxy config with no live backends");
    }
    const uploaded = await this.uploadAndValidate(preview.content);
    await this.activate(uploaded.candidate);
    const reloadResult = reload ? await this.reload() : null;
    this._lastPollAt = 0;
    return {
      ok: true,
      active: preview.active,
      skipped: preview.skipped,
      validation: uploaded.validation,
      reload: reloadResult,
    };
  }

  async deploy(expectedHash) {
    if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      const error = new Error("expectedHash must be a lowercase SHA-256 hash");
      error.status = 400;
      error.code = "INVALID_HASH";
      throw error;
    }

    // Sync is entirely local/read-only. Do not inspect or mutate the remote
    // until the exact server-regenerated state matches the user's sync.
    const config = this.config();
    const current = this.sync(config);
    if (current.hash !== expectedHash) {
      const error = new Error("HAProxy sync is stale; run Sync again before Apply & Send");
      error.status = 409;
      error.code = "STALE_SYNC";
      error.expectedHash = expectedHash;
      error.currentHash = current.hash;
      error.generatedAt = current.generatedAt;
      throw error;
    }
    if (current.active.length === 0) {
      const error = new Error("Refusing to deploy an HAProxy config with no live backends");
      error.status = 400;
      error.code = "NO_LIVE_BACKENDS";
      throw error;
    }

    const uploaded = await this.uploadAndValidate(current.content, config);
    await this.activate(uploaded.candidate, config);
    const restart = await this.restart(config);
    return {
      ok: true,
      hash: current.hash,
      generatedAt: current.generatedAt,
      active: current.active,
      skipped: current.skipped,
      diagnostics: {
        validation: uploaded.validation,
        activatedPath: config.managedSnippetPath,
        backupPath: `${config.managedSnippetPath}.sparkdash.bak`,
        restart,
        steps: ["validated", "activated", "restarted"],
      },
    };
  }

  async restart(config = this.config()) {
    const output = await this.exec(
      this.remoteTarget(config),
      `docker restart --timeout 30 ${shellQuote(config.containerName)}`,
      { timeoutMs: 45_000 }
    );
    this._lastPollAt = 0;
    return { ok: true, container: output || config.containerName };
  }

  async collectStatus() {
    const config = this.config();
    if (!config.enabled) return this.disabledStatus();
    const container = shellQuote(config.containerName);
    const statsUrls = [
      `http://127.0.0.1:${config.statsPort}/;csv`,
      `http://127.0.0.1:${config.statsPort}/stats;csv`,
    ];
    const hostStats = statsUrls
      .map((url) => `curl -fsS --max-time 3 ${shellQuote(url)}`)
      .join(" || ");
    const containerStats = statsUrls
      .map(
        (url) =>
          `curl -fsS --max-time 3 ${shellQuote(url)} || wget -qO- ${shellQuote(url)}`
      )
      .join(" || ");
    const command = [
      `docker inspect ${container} --format '{{.State.Status}}|{{.State.StartedAt}}'`,
      `docker exec ${container} haproxy -vv 2>/dev/null | sed -n '1p'`,
      `((${hostStats}) || docker exec ${container} sh -c ${shellQuote(containerStats)})`,
    ].join("; ");
    try {
      const output = await this.exec(this.remoteTarget(), command, { timeoutMs: STATUS_TIMEOUT_MS });
      const [inspect = "", versionLine = "", ...statsLines] = output.split(/\r?\n/);
      const [containerStatus, startedAt] = inspect.split("|");
      const rows = csvRows(statsLines.join("\n"));
      const backends = rows
        .filter((row) => row.svname === "BACKEND")
        .map((row) => ({
          name: row.pxname,
          status: row.status || "UNKNOWN",
          sessionsCurrent: finiteNumber(row.scur),
          sessionsTotal: finiteNumber(row.stot),
          bytesIn: finiteNumber(row.bin),
          bytesOut: finiteNumber(row.bout),
          errors: finiteNumber(row.ereq) + finiteNumber(row.econ) + finiteNumber(row.eresp),
          checkFailures: finiteNumber(row.chkfail),
        }));
      const totals = backends.reduce(
        (sum, row) => ({
          current: sum.current + row.sessionsCurrent,
          sessions: sum.sessions + row.sessionsTotal,
          bytesIn: sum.bytesIn + row.bytesIn,
          bytesOut: sum.bytesOut + row.bytesOut,
          errors: sum.errors + row.errors,
        }),
        { current: 0, sessions: 0, bytesIn: 0, bytesOut: 0, errors: 0 }
      );
      return {
        enabled: true,
        online: containerStatus === "running",
        containerStatus: containerStatus || "unknown",
        version: versionLine.match(/HAProxy version\s+([^\s]+)/i)?.[1] || null,
        uptimeSeconds: Number.isFinite(Date.parse(startedAt))
          ? Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
          : null,
        connectionsCurrent: totals.current,
        sessionsTotal: totals.sessions,
        bytesIn: totals.bytesIn,
        bytesOut: totals.bytesOut,
        errorsTotal: totals.errors,
        backends,
        checkedAt: Date.now(),
        error: null,
      };
    } catch (error) {
      return {
        ...this.disabledStatus(),
        enabled: true,
        containerStatus: "unreachable",
        error: error.message,
      };
    }
  }

  getCachedStatus() {
    return this.config().enabled ? this._cachedStatus : this.disabledStatus();
  }

  pollStatus({ maxAgeMs = 10_000 } = {}) {
    if (!this.config().enabled) {
      this._cachedStatus = this.disabledStatus();
      return Promise.resolve(this._cachedStatus);
    }
    if (Date.now() - this._lastPollAt < maxAgeMs) return Promise.resolve(this._cachedStatus);
    if (this._pollPromise) return this._pollPromise;
    this._pollPromise = this.collectStatus()
      .then((status) => {
        this._cachedStatus = status;
        this._lastPollAt = Date.now();
        return status;
      })
      .finally(() => {
        this._pollPromise = null;
      });
    return this._pollPromise;
  }
}
