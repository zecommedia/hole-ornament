/**
 * Minimal scoped console logger — a drop-in for the parent project's Winston
 * `child()` factory, so the copied modules work unchanged.
 *
 *   import { child } from './logger.js';
 *   const log = child('ai/v98-extract');
 *   log.info('done', { ms: 12 });
 *
 * Set LOG_LEVEL=debug to see debug() lines.
 */
function line(level, scope, msg, meta) {
    const t = new Date().toISOString().slice(11, 19);
    const m = meta && typeof meta === 'object' && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${t} ${level.padEnd(5)} [${scope}] ${msg}${m}`;
}

export function child(scope = 'app') {
    return {
        info: (msg, meta) => console.log(line('info', scope, msg, meta)),
        warn: (msg, meta) => console.warn(line('warn', scope, msg, meta)),
        error: (msg, meta) => console.error(line('error', scope, msg, meta)),
        debug: (msg, meta) => { if (process.env.LOG_LEVEL === 'debug') console.log(line('debug', scope, msg, meta)); },
    };
}

export default { child };
