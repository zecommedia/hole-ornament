/**
 * Per-IP fixed-window rate limiter — Sprint 1 defense-in-depth.
 *
 * Zero deps. Pure in-memory Map keyed by IP (or any custom key function).
 * Each entry tracks { count, windowStart }. A request that arrives after
 * windowStart + windowMs starts a fresh window. Beyond `max` requests in
 * one window → 429 with Retry-After.
 *
 * Cleanup runs opportunistically every 100th request via a module-level
 * counter so we never grow unbounded on a long-lived process.
 *
 * Returns an Express middleware: makeRateLimit({...}) → (req, res, next).
 */
import { child as logChild } from './logger.js';

const log = logChild('dashboard/rate-limit');

let requestCounter = 0;

export function makeRateLimit({ windowMs, max, key = (req) => req.ip } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('makeRateLimit: windowMs must be positive');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('makeRateLimit: max must be positive');
  }
  const buckets = new Map();

  function cleanup(now) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart > windowMs) {
        buckets.delete(k);
      }
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    requestCounter += 1;
    const now = Date.now();
    if (requestCounter % 100 === 0) {
      cleanup(now);
    }

    let k;
    try {
      k = key(req);
    } catch {
      k = req.ip || 'unknown';
    }
    if (!k) k = 'unknown';

    let b = buckets.get(k);
    if (!b || now - b.windowStart > windowMs) {
      b = { count: 1, windowStart: now };
      buckets.set(k, b);
      return next();
    }
    b.count += 1;
    if (b.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((b.windowStart + windowMs - now) / 1000));
      log.warn('rate limited', { key: k, count: b.count, max, path: req.path });
      res
        .status(429)
        .set('Retry-After', String(retryAfterSec))
        .json({ error: 'rate limited' });
      return;
    }
    next();
  };
}
