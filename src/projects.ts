import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ProjectConfig {
  name: string;
  path: string;
  description?: string;
  configs?: string[]; // List of Claude config files/dirs found
}

// Auto-discover projects with git repos or CLAUDE.md files
export function discoverProjects(baseDir: string = homedir()): ProjectConfig[] {
  const projects: ProjectConfig[] = [];

  try {
    const entries = readdirSync(baseDir);

    for (const entry of entries) {
      // Skip hidden directories and system folders
      if (entry.startsWith(".") || ["Library", "Applications", "System"].includes(entry)) {
        continue;
      }

      const fullPath = join(baseDir, entry);

      try {
        const stat = statSync(fullPath);
        if (!stat.isDirectory()) continue;

        // Check for Claude-related configs
        const hasClaude = existsSync(join(fullPath, "CLAUDE.md"));
        const hasClaudeDir = existsSync(join(fullPath, ".claude"));
        const hasAgents = hasClaudeDir && existsSync(join(fullPath, ".claude", "agents"));
        const hasSettings = hasClaudeDir && existsSync(join(fullPath, ".claude", "settings.json"));

        // Only include projects with actual Claude configs
        if (hasClaude || hasClaudeDir) {
          let description = "";
          const configs: string[] = [];

          // Collect what configs exist
          if (hasClaude) configs.push("CLAUDE.md");
          if (hasAgents) configs.push("agents");
          if (hasSettings) configs.push("settings");

          // Try to read description from CLAUDE.md first line
          if (hasClaude) {
            try {
              const claudeMd = require("fs").readFileSync(join(fullPath, "CLAUDE.md"), "utf-8");
              const firstLine = claudeMd.split("\n")[0].replace(/^#\s*/, "").trim();
              if (firstLine && firstLine.length < 100) {
                description = firstLine;
              }
            } catch {}
          }

          projects.push({
            name: entry,
            path: fullPath,
            description: description || "Claude project",
            configs,
          });
        }
      } catch (err) {
        // Skip directories we can't read
        continue;
      }
    }
  } catch (err) {
    console.warn(`Failed to discover projects in ${baseDir}:`, err);
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

export function findProjectByName(name: string, projects: ProjectConfig[]): ProjectConfig | null {
  const lower = name.toLowerCase();

  // Exact match first
  const exact = projects.find((p) => p.name.toLowerCase() === lower);
  if (exact) return exact;

  // Partial match
  const partial = projects.find((p) => p.name.toLowerCase().includes(lower));
  if (partial) return partial;

  return null;
}

export function formatProjectsList(projects: ProjectConfig[]): string {
  if (projects.length === 0) {
    return "No projects found.";
  }

  const lines = ["📁 Available projects:", ""];

  for (const project of projects) {
    lines.push(`• ${project.name}`);
    if (project.description) {
      lines.push(`  ${project.description}`);
    }
    lines.push(`  ${project.path}`);
    lines.push("");
  }

  lines.push(`Use /switch <name> to switch to a project.`);

  return lines.join("\n");
}
