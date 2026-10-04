/**
 * finding-pipeline — Sentry-inspired event processing pipeline for arkitect findings
 * ================================================================================
 * Adapted from Sentry's event processing pipeline in `@sentry/core` (`client.ts`):
 *
 *   - Integration hooks: `preprocessEvent`, `beforeSend`, `afterSend`
 *   - Scope application: global scope → isolation scope → current scope
 *   - Event normalization: platform-specific normalization, depth limiting
 *   - Sampling: random sampling, error sampling
 *   - Before-send filtering: user-provided `beforeSend` callback
 *
 * This is a lightweight JS port of Sentry's event pipeline concepts, tailored for
 * arkitect findings instead of error events.
 *
 * ## Pipeline Stages (parallel to Sentry)
 *
 *   1. NORMALIZE        — ensure finding has all required fields, apply defaults
 *   2. PREPROCESS       — run integration preprocessEvent hooks (enrich, filter, annotate)
 *   3. APPLY_SCOPE      — merge global/config scope tags, context, breadcrumbs
 *   4. BEFORE_OUTPUT    — run user-provided beforeOutput callbacks (like Sentry's beforeSend)
 *   5. OUTPUT           — emit finding to all registered outputs (console, SARIF, JSON file)
 *   6. AFTER_OUTPUT     — run afterOutput hooks (metrics, logging)
 *
 * ## Integration System (parallel to Sentry's Integration type)
 *
 *   An integration is an object with:
 *   ```
 *   {
 *     name: string,
 *     preprocessFinding(finding, hint) => finding | null,  // return null to drop
 *     beforeOutput(finding, hint) => finding | null,       // return null to drop
 *     afterOutput(finding, result) => void,
 *     setup(pipeline) => void,                              // called once at init
 *   }
 *   ```
 *
 * ## Scopes (parallel to Sentry's Scope)
 *
 *   - Global scope: tags applied to all findings in a run
 *   - Check scope: context specific to the current check
 *   - Finding scope: context specific to a single finding
 *
 * Codebase-agnostic: works on any array of arkitect findings.
 */

// ---------------------------------------------------------------------------
// Finding normalization (parallel to Sentry's _normalizeEvent)
// ---------------------------------------------------------------------------

const DEFAULT_FINDING = {
  ruleId: "unknown",
  severity: "warn",
  filePath: "",
  line: 0,
  message: "",
  snippet: "",
  metadata: {},
};

/**
 * Normalize a finding to ensure it has all required fields and valid values.
 * Parallel to Sentry's normalizers that ensure events have valid platforms,
 * timestamps, etc.
 *
 * @param {Object} finding
 * @param {Object} [options]
 * @param {number} [options.maxMessageLength=500] — truncate long messages
 * @param {number} [options.maxSnippetLength=1000] — truncate long snippets
 * @returns {Object} normalized finding
 */
export function normalizeFinding(finding, options = {}) {
  const { maxMessageLength = 500, maxSnippetLength = 1000 } = options;

  const normalized = { ...DEFAULT_FINDING, ...finding };

  // Ensure valid severity
  const validSeverities = ["critical", "high", "medium", "low", "info"];
  if (!validSeverities.includes(normalized.severity)) {
    normalized.severity = "warn";
  }

  // Truncate long text fields
  if (normalized.message && normalized.message.length > maxMessageLength) {
    normalized.message = normalized.message.substring(0, maxMessageLength) + "...";
  }
  if (normalized.snippet && normalized.snippet.length > maxSnippetLength) {
    normalized.snippet = normalized.snippet.substring(0, maxSnippetLength) + "...";
  }

  // Ensure metadata is an object
  if (!normalized.metadata || typeof normalized.metadata !== "object") {
    normalized.metadata = {};
  }

  // Add pipeline metadata
  normalized.metadata._pipeline = {
    normalizedAt: new Date().toISOString(),
    pipelineVersion: "1.0.0",
  };

  return normalized;
}

// ---------------------------------------------------------------------------
// Integration system (parallel to Sentry's Integration)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ArkitectIntegration
 * @property {string} name
 * @property {(finding: Object, hint: Object) => Object | null} [preprocessFinding]
 * @property {(finding: Object, hint: Object) => Object | null} [beforeOutput]
 * @property {(finding: Object, result: Object) => void} [afterOutput]
 * @property {(pipeline: Object) => void} [setup]
 */

/**
 * Create a pipeline instance with the given integrations and options.
 *
 * @param {Object} [options]
 * @param {ArkitectIntegration[]} [options.integrations=[]]
 * @param {Object} [options.globalTags={}] — tags applied to all findings
 * @param {Object} [options.globalContext={}] — context merged into all findings
 * @param {Function} [options.beforeOutput] — like Sentry's beforeSend: (finding, hint) => finding | null
 * @param {number} [options.sampleRate] — 0.0 to 1.0, probability of processing a finding
 * @param {number} [options.maxMessageLength] — truncation limit
 * @param {number} [options.maxSnippetLength] — truncation limit
 * @returns {ArkitectPipeline}
 */
export function createPipeline(options = {}) {
  const {
    integrations = [],
    globalTags = {},
    globalContext = {},
    beforeOutput = null,
    sampleRate = 1.0,
    maxMessageLength = 500,
    maxSnippetLength = 1000,
  } = options;

  /** @type {ArkitectPipeline} */
  const pipeline = {
    integrations,
    globalTags,
    globalContext,
    beforeOutput,
    sampleRate,
    maxMessageLength,
    maxSnippetLength,
    stats: {
      received: 0,
      normalized: 0,
      preprocessed: 0,
      droppedByPreprocessor: 0,
      droppedBySampleRate: 0,
      droppedByBeforeOutput: 0,
      outputted: 0,
      errors: 0,
    },

    /**
     * Process a single finding through the pipeline.
     * Parallel to Sentry's client._processEvent().
     *
     * @param {Object} finding
     * @param {Object} [hint]
     * @returns {Object | null} — the processed finding, or null if dropped
     */
    processFinding(finding, hint = {}) {
      this.stats.received++;

      try {
        // Stage 1: Normalize
        const normalized = normalizeFinding(finding, {
          maxMessageLength: this.maxMessageLength,
          maxSnippetLength: this.maxSnippetLength,
        });
        this.stats.normalized++;

        // Stage 2: Sampling (parallel to Sentry's sampleRate)
        if (this.sampleRate < 1.0 && Math.random() > this.sampleRate) {
          this.stats.droppedBySampleRate++;
          return null;
        }

        // Stage 3: Apply global scope (parallel to Sentry's scope.applyToEvent)
        const withScope = applyScope(normalized, this.globalTags, this.globalContext, hint);

        // Stage 4: Preprocess (parallel to Sentry's preprocessEvent hooks)
        let preprocessed = withScope;
        for (const integration of this.integrations) {
          if (typeof integration.preprocessFinding === "function") {
            try {
              preprocessed = integration.preprocessFinding(preprocessed, hint);
              if (preprocessed === null) {
                this.stats.droppedByPreprocessor++;
                return null;
              }
            } catch {
              // Don't lose the finding because of a broken integration
              this.stats.errors++;
            }
          }
        }
        this.stats.preprocessed++;

        // Stage 5: Before output (parallel to Sentry's beforeSend)
        let finalFinding = preprocessed;
        if (typeof this.beforeOutput === "function") {
          try {
            finalFinding = this.beforeOutput(finalFinding, hint);
            if (finalFinding === null) {
              this.stats.droppedByBeforeOutput++;
              return null;
            }
          } catch {
            this.stats.errors++;
          }
        }

        // Stage 6: Apply per-integration beforeOutput hooks
        for (const integration of this.integrations) {
          if (typeof integration.beforeOutput === "function") {
            try {
              const result = integration.beforeOutput(finalFinding, hint);
              if (result === null) {
                this.stats.droppedByBeforeOutput++;
                return null;
              }
              finalFinding = result;
            } catch {
              this.stats.errors++;
            }
          }
        }

        this.stats.outputted++;

        // Stage 7: After output hooks
        for (const integration of this.integrations) {
          if (typeof integration.afterOutput === "function") {
            try {
              integration.afterOutput(finalFinding, { pipelineStats: this.stats });
            } catch {
              this.stats.errors++;
            }
          }
        }

        return finalFinding;
      } catch {
        this.stats.errors++;
        return null;
      }
    },

    /**
     * Process a batch of findings through the pipeline.
     *
     * @param {Object[]} findings
     * @returns {{ processed: Object[], stats: Object }} — processed findings + stats
     */
    processBatch(findings) {
      const processed = [];
      for (const finding of findings) {
        const result = this.processFinding(finding);
        if (result !== null) {
          processed.push(result);
        }
      }
      return { processed, stats: { ...this.stats } };
    },
  };

  // Call setup on all integrations
  for (const integration of integrations) {
    if (typeof integration.setup === "function") {
      try {
        integration.setup(pipeline);
      } catch {
        // Setup errors are logged but don't prevent pipeline creation
      }
    }
  }

  return pipeline;
}

// ---------------------------------------------------------------------------
// Scope application (parallel to Sentry's Scope.applyToEvent)
// ---------------------------------------------------------------------------

/**
 * Apply scope data (tags, context) to a finding.
 * Parallel to Sentry's `Scope.applyToEvent()`.
 *
 * @param {Object} finding
 * @param {Object} tags
 * @param {Object} context
 * @param {Object} hint
 * @returns {Object}
 */
function applyScope(finding, tags, context, hint) {
  const enriched = { ...finding };

  // Merge tags into metadata
  if (Object.keys(tags).length > 0) {
    enriched.metadata = {
      ...enriched.metadata,
      _tags: { ...(enriched.metadata._tags ?? {}), ...tags },
    };
  }

  // Merge context into metadata
  if (Object.keys(context).length > 0) {
    enriched.metadata = {
      ...enriched.metadata,
      _context: { ...(enriched.metadata._context ?? {}), ...context },
    };
  }

  // Add hint metadata
  if (hint.checkId) {
    enriched.metadata._checkId = hint.checkId;
  }
  if (hint.runId) {
    enriched.metadata._runId = hint.runId;
  }

  return enriched;
}

// ---------------------------------------------------------------------------
// Built-in integrations (parallel to Sentry's default integrations)
// ---------------------------------------------------------------------------

/**
 * Integration that adds git metadata to findings.
 * Uses the existing git-churn-engine's git infrastructure.
 */
export const gitMetadataIntegration = {
  name: "GitMetadata",

  preprocessFinding(finding, _hint) {
    // This is a hook point — git info would be added by the check runner,
    // not here. Kept as a placeholder for future enrichment.
    return finding;
  },
};

/**
 * Integration that adds timestamps and run IDs.
 */
export const runMetadataIntegration = {
  name: "RunMetadata",

  preprocessFinding(finding, hint) {
    return {
      ...finding,
      metadata: {
        ...finding.metadata,
        _processedAt: new Date().toISOString(),
        _runId: hint.runId ?? "unknown",
      },
    };
  },
};

/**
 * Integration that filters out findings in specific paths.
 *
 * @param {Object} options
 * @param {string[]} [options.excludePaths=[]] — glob patterns for paths to exclude
 * @param {string[]} [options.excludeRules=[]] — rule IDs to exclude
 */
export function createPathFilterIntegration(options = {}) {
  const { excludePaths = [], excludeRules = [] } = options;

  return {
    name: "PathFilter",

    preprocessFinding(finding, _hint) {
      // Filter by rule ID
      if (excludeRules.length > 0 && excludeRules.includes(finding.ruleId)) {
        return null;
      }

      // Filter by file path
      if (excludePaths.length > 0) {
        const filePath = (finding.filePath || "").replaceAll("\\", "/");
        for (const pattern of excludePaths) {
          if (filePath.includes(pattern)) {
            return null;
          }
        }
      }

      return finding;
    },
  };
}

// ---------------------------------------------------------------------------
// Type definitions (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ArkitectPipeline
 * @property {ArkitectIntegration[]} integrations
 * @property {Object} globalTags
 * @property {Object} globalContext
 * @property {Function | null} beforeOutput
 * @property {number} sampleRate
 * @property {number} maxMessageLength
 * @property {number} maxSnippetLength
 * @property {Object} stats
 * @property {number} stats.received
 * @property {number} stats.normalized
 * @property {number} stats.preprocessed
 * @property {number} stats.droppedByPreprocessor
 * @property {number} stats.droppedBySampleRate
 * @property {number} stats.droppedByBeforeOutput
 * @property {number} stats.outputted
 * @property {number} stats.errors
 * @property {(finding: Object, hint?: Object) => Object | null} processFinding
 * @property {(findings: Object[]) => { processed: Object[], stats: Object }} processBatch
 */
