import {
  runSurfaceSizeCoverageAudit,
  SURFACE_SIZE_COVERAGE_DEFAULTS,
} from "@saydeploy/architect/engines/surface/surface-size-coverage-engine";

export const audit = {
  id: "surface-size-coverage",
  title: "Surface Size And Coverage",
  category: "maintainability",
  defaultConfig: SURFACE_SIZE_COVERAGE_DEFAULTS,
  run: runSurfaceSizeCoverageAudit,
};
