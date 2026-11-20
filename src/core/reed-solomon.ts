const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = ((x << 1) ^ (x & 0x80 ? 0x1d : 0)) & 0xff;
  }
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255];
  }
}

function mul(a: number, b: number): number {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

function div(a: number, b: number): number {
  if (!b) throw new RangeError('GF div by 0');
  return a ? EXP[(LOG[a] - LOG[b] + 255) % 255] : 0;
}

function polyMul(p: number[], q: number[]): number[] {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) {
      r[i + j] ^= mul(p[i], q[j]);
    }
  }
  return r;
}

function genPoly(nsym: number): number[] {
  let g: number[] = [1];
  for (let i = 0; i < nsym; i++) {
    g = polyMul(g, [1, EXP[i]]);
  }
  return g;
}

export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  const gen = genPoly(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);

  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        out[i + j] ^= mul(gen[j], coef);
      }
    }
  }

  out.set(data);
  return out;
}

function calcSyndromes(msg: Uint8Array, nsym: number): number[] {
  const synd: number[] = [];
  for (let i = 0; i < nsym; i++) {
    let v = 0;
    for (let j = 0; j < msg.length; j++) {
      v = mul(v, EXP[i]) ^ msg[j];
    }
    synd.push(v);
  }
  return synd;
}

function berlekampMassey(synd: number[], nsym: number): number[] {
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;

  for (let n = 0; n < nsym; n++) {
    let d = synd[n];
    for (let i = 1; i < C.length; i++) {
      if (n - i >= 0) {
        d ^= mul(C[i], synd[n - i]);
      }
    }

    if (d === 0) {
      m++;
    } else {
      const T = [...C];
      const scale = div(d, b);
      while (C.length < B.length + m) C.push(0);
      for (let i = 0; i < B.length; i++) {
        C[i + m] ^= mul(scale, B[i]);
      }

      if (2 * L <= n) {
        L = n + 1 - L;
        B = T;
        b = d;
        m = 1;
      } else {
        m++;
      }
    }
  }

  return C;
}

export interface RSDecodeResult {
  data: Uint8Array;
  corrected: number;
}

export function rsDecode(received: Uint8Array, nsym: number): RSDecodeResult {
  const n = received.length;
  const synd = calcSyndromes(received, nsym);

  if (synd.every((s) => s === 0)) {
    return { data: received.slice(0, n - nsym), corrected: 0 };
  }

  const C = berlekampMassey(synd, nsym);
  const nErr = C.length - 1;

  if (nErr === 0 || nErr > Math.floor(nsym / 2)) {
    throw new Error(`Errors exceed correction capacity (${nErr} > ${Math.floor(nsym / 2)})`);
  }

  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = n - 1 - i;
    const x = EXP[(255 - (p % 255)) % 255];
    let val = 0;
    let xPow = 1;
    for (let k = 0; k < C.length; k++) {
      val ^= mul(C[k], xPow);
      xPow = mul(xPow, x);
    }
    if (val === 0) {
      pos.push(i);
    }
  }

  if (pos.length !== nErr) {
    throw new Error(`Chien search found ${pos.length} roots, expected ${nErr}`);
  }

  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) {
    for (let j = 0; j < C.length && j <= i; j++) {
      omega[i] ^= mul(synd[i - j], C[j]);
    }
  }

  const corrected = new Uint8Array(received);
  for (const pIdx of pos) {
    const p = n - 1 - pIdx;
    const Xi = EXP[p % 255];
    const XiInv = EXP[(255 - (p % 255)) % 255];

    let omegaVal = 0;
    let xPow = 1;
    for (let i = 0; i < omega.length; i++) {
      omegaVal ^= mul(omega[i], xPow);
      xPow = mul(xPow, XiInv);
    }

    let lprimeVal = 0;
    xPow = 1;
    for (let i = 1; i < C.length; i += 2) {
      lprimeVal ^= mul(C[i], xPow);
      xPow = mul(xPow, mul(XiInv, XiInv));
    }

    if (lprimeVal === 0) {
      throw new Error('Forney error: derivative evaluated to zero');
    }

    const errVal = mul(Xi, div(omegaVal, lprimeVal));
    corrected[pIdx] ^= errVal;
  }

  const verify = calcSyndromes(corrected, nsym);
  if (verify.some((s) => s !== 0)) {
    throw new Error('RS post-correction verification failed');
  }

  return {
    data: corrected.slice(0, n - nsym),
    corrected: nErr,
  };
}
