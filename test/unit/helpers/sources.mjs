import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * 一个「面」的全部源码，按文件名排序拼起来。
 *
 * 下面那些断言问的是「这一面有没有做某件事」，不是「某个文件里有没有某一行」——
 * 自从一个两千行的文件拆成一组模块，后者就只是前者的一种偶然写法了。
 *
 * 要断言的确实是**入口文件本身**（比如 shared/*.js 的装载顺序），就照旧直接读那个
 * 文件，别用这个。
 */
function surfaceSource(dir, matches) {
  const abs = path.join(ROOT, dir);
  return readdirSync(abs)
    .filter(matches)
    .sort()
    .map((name) => readFileSync(path.join(abs, name), 'utf8'))
    .join('\n');
}

/** service worker 全体：background/*.js。新增模块会自动进来，不用改测试。 */
export function workerSource() {
  return surfaceSource('background', (name) => name.endsWith('.js'));
}
