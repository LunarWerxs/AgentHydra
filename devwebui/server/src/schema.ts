// The .devwebui file schema (ID_RE / ProcessSchema / DevWebUIFileSchema and the types
// inferred from them) is defined once in ../../shared/schema, which the web client reads
// too. Re-exported here so a module nested under src/projects/ reaches it with a one-level
// import instead of climbing three levels to the repo root.
export * from "../../shared/schema";
