// Detects "word salad" from a model running with broken GPU math (e.g. fp16 shaders that a GPU
// claims to support but computes wrong). Healthy models — even tiny ones — don't glue random
// CJK characters onto English words and numbers when the user wrote in English.

const CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af';
const HAS_CJK = new RegExp(`[${CJK}]`);
const GLUED = new RegExp(`[a-z0-9][${CJK}]|[${CJK}][a-z0-9]`, 'gi');

export function looksGarbled(text = '', prompt = '') {
  const t = text.slice(0, 1500);
  if (t.length < 60) return false;
  if ((t.match(/�/g) || []).length >= 3) return true;
  if (HAS_CJK.test(prompt)) return false;
  if ((t.match(GLUED) || []).length >= 3) return true;
  // A few Asian characters scattered through an English reply (a real Chinese answer is mostly Chinese).
  const cjk = (t.match(new RegExp(`[${CJK}]`, 'g')) || []).length;
  const latin = (t.match(/[a-z]/gi) || []).length;
  return cjk >= 3 && latin >= 30 && cjk / (cjk + latin) < 0.25;
}
