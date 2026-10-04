// Minimal profiler shim. Upstream impeccable wraps every detection step in a
// profiler that records timings and finding counts; the arkitect integration
// does not surface those metrics, so the wrappers degrade to thin pass-throughs.
//
// Upstream call shape:
//   profileStep(profile, metadata, fn)
//   profileStepAsync(profile, metadata, fn)
//   profileFindings(profile, metadata, fn)

export function profileStep(_profile, _meta, fn) {
  return fn();
}

export function profileStepAsync(_profile, _meta, fn) {
  return Promise.resolve().then(() => fn());
}

export function profileFindings(_profile, _meta, fn) {
  return fn();
}

export function createDetectorProfile() {
  return null;
}

export function summarizeDetectorProfile() {
  return null;
}
