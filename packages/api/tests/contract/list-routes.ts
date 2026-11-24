/**
 * Turn Fastify's printRoutes() tree into sorted "METHOD /path" lines
 * (HEAD and OPTIONS left out). Each tree line is a path segment appended to
 * its parent's path. Mirrors scripts/dump-routes.mjs.
 */
export function listRoutes(tree: string): string[] {
  const stack: string[] = [];
  const out = new Set<string>();
  for (const line of tree.split("\n")) {
    const m = line.match(/^([│ ]*)(?:├── |└── )(.*?)(?: \(([A-Z, ]+)\))?$/u);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    const path = (depth > 0 ? stack[depth - 1] : "") + m[2]!;
    stack[depth] = path;
    if (m[3]) {
      for (const method of m[3].split(",").map((s) => s.trim())) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        out.add(`${method} ${path}`);
      }
    }
  }
  return [...out].sort();
}
