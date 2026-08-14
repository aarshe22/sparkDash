import type {
  HaproxyBackendMapping,
  HaproxySettings,
  SparkSnapshot,
} from "../api/types";

function identity(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function legacyMatchesSpark(mapping: HaproxyBackendMapping, spark: SparkSnapshot): boolean {
  const wanted = identity(mapping.name);
  const id = identity(spark.id);
  const name = identity(spark.name);
  return Boolean(wanted) && (wanted === id || wanted === name || name.startsWith(wanted));
}

export function findHaproxyMappingIndex(
  settings: HaproxySettings | null | undefined,
  spark: SparkSnapshot,
  llmPort: number
): number {
  const mappings = settings?.backendMappings ?? [];
  const exact = mappings.findIndex(
    (mapping) => identity(mapping.sparkId) === identity(spark.id) && mapping.llmPort === llmPort
  );
  if (exact >= 0) return exact;
  const primaryPort = spark.llmPorts?.[0] ?? spark.llmPort;
  if (llmPort !== primaryPort) return -1;
  return mappings.findIndex(
    (mapping) =>
      mapping.llmPort == null &&
      (mapping.sparkId
        ? identity(mapping.sparkId) === identity(spark.id)
        : legacyMatchesSpark(mapping, spark))
  );
}

export function haproxyPublicPort(
  settings: HaproxySettings | null | undefined,
  spark: SparkSnapshot,
  llmPort: number
): number | null {
  const index = findHaproxyMappingIndex(settings, spark, llmPort);
  return index >= 0 ? settings!.backendMappings[index].port : null;
}

export function endpointMappingName(spark: SparkSnapshot, llmPort: number): string {
  const base = String(spark.id).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 52) || "Spark";
  return `${base}_${llmPort}`.slice(0, 64);
}
