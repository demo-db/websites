import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const visibleBuildRoutes = join(root, 'dist/db');
const privateBuildRoutes = join(root, 'dist/_db');
await cp(visibleBuildRoutes, privateBuildRoutes, { recursive: true, force: true });
await rm(visibleBuildRoutes, { recursive: true, force: true });
console.log('Moved generated database pages into the Worker-only /_db asset namespace.');
