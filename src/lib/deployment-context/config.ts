/** Documented limits and retrieval window for deployment context (stage 4C). */
export const DEPLOYMENT_CONTEXT_LIMITS = {
  maxSourceDeploymentIdLength: 128,
  maxSourceEventIdLength: 128,
  maxIntegrationKeyLength: 64,
  maxRepositoryLength: 200,
  maxArtifactRefLength: 128,
  maxCommitShaLength: 64,
  minCommitShaLength: 7,
  maxRecordsPerRetrieval: 8,
  lookbackBeforeReferenceMs: 7 * 24 * 60 * 60 * 1000,
  maxFutureSkewMs: 5 * 60 * 1000,
} as const;

export const DEPLOYMENT_TEMPORAL_NOTE =
  "Temporal proximity to an incident does not, by itself, implicate a recorded deployment event.";

export const DEPLOYMENT_RUNNING_VERSION_UNKNOWN =
  "Running service version is unknown when multiple successful deployments overlap or completion is missing.";

export const DEPLOYMENT_CODE_ASSOCIATION_NOTE =
  "Imported repository code does not represent the running service unless deployment evidence supports that association.";
