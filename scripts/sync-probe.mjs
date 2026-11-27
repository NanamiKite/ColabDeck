import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'packages/probe/colabdeck_probe.py');
const targetDir = path.join(root, 'packages/extension/resources/probe');
const target = path.join(targetDir, 'colabdeck_probe.py');
const notebookSource = path.join(root, 'packages/probe/colabdeck_notebook.py');
const notebookTarget = path.join(targetDir, 'colabdeck_notebook.py');

await mkdir(targetDir, { recursive: true });
await copyFile(source, target);
console.log(`[sync:probe] ${path.relative(root, source)} -> ${path.relative(root, target)}`);
await copyFile(notebookSource, notebookTarget);
console.log(`[sync:probe] ${path.relative(root, notebookSource)} -> ${path.relative(root, notebookTarget)}`);
