import { Hono } from 'hono';
import type { Env, HonoVars } from '../types';

const health = new Hono<{ Bindings: Env; Variables: HonoVars }>();

health.get('/', (c) =>
  c.json({
    ok: true,
    service: 'fothy',
    version: '0.1.0',
    timestamp: Date.now(),
  })
);

export default health;
