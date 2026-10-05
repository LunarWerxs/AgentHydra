import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { expect, test } from "bun:test";
import { Manager, START_STAGGER_MS } from "../server/src/manager";
import type { LoadedProject, ProcessDef } from "../server/src/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const keepAliveCommand = () =>
  `"${process.execPath.replace(/"/g, '\\"')}" -e "setInterval(() => {}, 1000)"`;

function processDef(localId: string): ProcessDef {
  return {
    id: `project.${localId}`,
    localId,
    name: localId,
    command: keepAliveCommand(),
    cwd: import.meta.dir,
    autostart: true,
    projectId: "project",
    projectName: "Project",
  };
}

function project(processes: ProcessDef[]): LoadedProject {
  return {
    id: "project",
    name: "Project",
    path: `${import.meta.dir}\\.devwebui`,
    dir: import.meta.dir,
    processes,
  };
}

const runningCount = (manager: Manager) =>
  manager.list().filter((process) => process.status === "running").length;

test(
  "project starts are staggered instead of launching every process at once",
  async () => {
    const manager = new Manager();
    manager.monitorResources = false;
    manager.applyMonitorResources();

    manager.addProject(project([processDef("one"), processDef("two")]), { autostart: false });
    try {
      manager.startProject("project");

      expect(runningCount(manager)).toBe(1);
      await sleep(Math.floor(START_STAGGER_MS / 2));
      expect(runningCount(manager)).toBe(1);

      await sleep(START_STAGGER_MS);
      expect(runningCount(manager)).toBe(2);
    } finally {
      await manager.stopProject("project");
      manager.dispose();
    }
  },
  START_STAGGER_MS * 5,
);
