import { readFile, writeFile } from 'node:fs/promises';
import { embedReport } from '../docs/lib/embed.mjs';

export async function writeReport(outputPath, before, after) {
  let template;
  try {
    template = await readFile(
      new URL('../offline/atlas.html', import.meta.url),
      'utf8',
    );
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        'Offline viewer missing. Run npm ci and npm run build in the source checkout, or install the GitHub release package.',
      );
    throw error;
  }
  await writeFile(outputPath, embedReport(template, before, after), {
    flag: 'wx',
  });
}
