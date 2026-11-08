// LAN scan for Moonraker printers — runs on the backend (wired, reaches every
// SSID/subnet), so it's faster and more complete than a browser-side scan.

export interface Found { ip: string; hostname: string }

async function probe(ip: string, timeoutMs: number): Promise<Found | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://${ip}:7125/printer/info`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j: any = await res.json();
    return { ip, hostname: j?.result?.hostname || '' };
  } catch {
    return null;
  }
}

export async function scanSubnet(base: string, timeoutMs = 2000, concurrency = 24): Promise<Found[]> {
  const prefix = base.endsWith('.') ? base : base + '.';
  const nums = Array.from({ length: 254 }, (_, i) => i + 1);
  const found: Found[] = [];
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < nums.length) {
      const n = nums[idx++];
      const r = await probe(prefix + n, timeoutMs);
      if (r) found.push(r);
    }
  });
  await Promise.all(workers);
  found.sort((a, b) => parseInt(a.ip.split('.').pop()!) - parseInt(b.ip.split('.').pop()!));
  return found;
}
