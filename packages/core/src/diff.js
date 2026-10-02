// Small line-based LCS diff, good enough for showing agent edits.

export function diffLines(a = '', b = '') {
  const A = a === '' ? [] : a.split('\n');
  const B = b === '' ? [] : b.split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;

  const out = [];
  for (let i = 0; i < pre; i++) out.push({ type: ' ', text: A[i], a: i + 1, b: i + 1 });

  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const n = a2.length;
  const m = b2.length;

  if (n * m > 4_000_000) {
    a2.forEach((t, i) => out.push({ type: '-', text: t, a: pre + i + 1 }));
    b2.forEach((t, i) => out.push({ type: '+', text: t, b: pre + i + 1 }));
  } else {
    const W = m + 1;
    const dp = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * W + j] = a2[i] === b2[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) {
        out.push({ type: ' ', text: a2[i], a: pre + i + 1, b: pre + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[(i + 1) * W + j] >= dp[i * W + j + 1])) {
        out.push({ type: '-', text: a2[i], a: pre + i + 1 });
        i++;
      } else {
        out.push({ type: '+', text: b2[j], b: pre + j + 1 });
        j++;
      }
    }
  }

  const offA = A.length - suf;
  const offB = B.length - suf;
  for (let k = 0; k < suf; k++) out.push({ type: ' ', text: A[offA + k], a: offA + k + 1, b: offB + k + 1 });
  return out;
}

export function diffStats(d) {
  let added = 0;
  let removed = 0;
  for (const l of d) {
    if (l.type === '+') added++;
    else if (l.type === '-') removed++;
  }
  return { added, removed };
}

/** Collapse unchanged runs, keeping `context` lines around changes. */
export function diffHunks(d, context = 3) {
  const keep = new Array(d.length).fill(false);
  d.forEach((l, i) => {
    if (l.type !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  d.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ type: 'skip', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ type: 'skip', count: skipped });
  return out;
}
