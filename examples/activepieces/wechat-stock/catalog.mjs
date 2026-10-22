import { readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

/** Freeze only canonical reading-list entries, never backups, recommendations or directory indexes. */
export async function freezeCatalog(reportRoot, publicBaseUrl) {
  const root = await realpath(reportRoot), articles = [], seen = new Set();
  for (const volume of ['上册-研究报告', '中册-行业解决方案', '下册-案例汇编']) {
    const text = await readFile(join(root, volume, 'README.md'), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.startsWith('|') && !(volume === '中册-行业解决方案' && line.startsWith('- ['))) continue;
      const match = /\[([^\]]+)\]\(([^)]+\.md)\)/.exec(line);
      if (!match) continue;
      const [, title, link] = match;
      if (link.includes('..') || /(?:^|\/)README\.md$/.test(link) || /备份|草稿|assets\//.test(link)) continue;
      const valid = volume === '下册-案例汇编' ? /^[^/]+\/(?:[A-Z]\d{2}|附[A-Z]\d{2})-/.test(link)
        : /^(?:\d{2}|[A-Z]\d{2}|附录[A-Z])-/.test(link);
      if (!valid) continue;
      const sourcePath = await realpath(join(root, volume, link)), articleKey = relative(root, sourcePath);
      if (articleKey.startsWith('..') || isAbsolute(articleKey)) throw new Error('Catalog entry escapes report root');
      if (seen.has(articleKey)) continue;
      seen.add(articleKey);
      const bytes = await readFile(sourcePath);
      articles.push({ articleKey, issue: articles.length + 1, title, volume, sourcePath,
        sourceSha256: createHash('sha256').update(bytes).digest('hex'), revision: 1, ready: true,
        url: new URL(articleKey.split('/').map(encodeURIComponent).join('/').replace(/\.md$/, '.html'), publicBaseUrl).href });
    }
  }
  const link = article => article ? { title: article.title, url: article.url, status: 'report' } : null;
  return articles.map((article, index) => ({ ...article, previous: link(articles[index - 1]), next: link(articles[index + 1]) }));
}
