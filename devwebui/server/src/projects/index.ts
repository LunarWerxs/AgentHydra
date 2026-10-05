// The .devwebui schema (ID_RE / ProcessSchema / DevWebUIFileSchema / DevWebUIProcess)
// is the single source of truth in ../schema (itself a re-export of the shared one);
// re-export the inferred type so `import { DevWebUIProcess } from "./projects"` works.
export type { DevWebUIProcess } from "../schema";

export {
  projectIdFromPath,
  readDevWebUIFile,
  addProcessToFile,
  updateProcessInFile,
  removeProcessFromFile,
  setProcessStarred,
  updateProjectMeta,
  readRegistry,
  registryAdd,
  registryRemove,
  readIgnoredProjects,
  ignoreProject,
  unignoreProject,
} from "./file-store";

export { browseForDevWebUIFile, browseForFolder } from "./native-dialogs";

export type { LoadTarget } from "./load-target";
export { resolveLoadTarget, scaffoldDevWebUIFile } from "./load-target";

export { looksLikeGitUrl, suggestCloneDest, cloneRepo } from "./git-clone";
