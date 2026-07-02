import os from 'node:os';
import { Router } from 'express';

// LAN discovery: inside docker the container can't see the host's LAN IP,
// so HOST_IP (set in .env) wins; the interface scan covers bare `npm start`.
export function infoRouter({ env = process.env } = {}) {
  const r = Router();
  r.get('/', (_req, res) => {
    let lanIps = [];
    if (env.HOST_IP) {
      lanIps = [env.HOST_IP];
    } else {
      for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) {
          if (i.family === 'IPv4' && !i.internal) lanIps.push(i.address);
        }
      }
    }
    res.json({ ok: true, lanIps });
  });
  return r;
}
