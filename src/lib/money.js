// Acá se da formato a los montos en pesos colombianos
const group = (n) => Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export function cop(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '−$' : '$') + group(v);
}

// Divide el monto en parte principal y los últimos tres dígitos (".000"), que se muestran más pequeños
export function copParts(n) {
  const text = cop(n);
  const i = text.lastIndexOf('.');
  if (i === -1) return [text, ''];
  return [text.slice(0, i), text.slice(i)];
}

export function compact(n) {
  const v = Math.abs(Number(n) || 0);
  const sign = n < 0 ? '−' : '';
  if (v >= 1e9) return `${sign}$${(v / 1e9).toFixed(1).replace('.', ',')} mil M`;
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(1).replace('.', ',').replace(',0', '')} M`;
  if (v >= 1e3) return `${sign}$${Math.round(v / 1e3)} mil`;
  return cop(n);
}

export function parseCop(text) {
  return Number(String(text ?? '').replace(/[^\d]/g, '')) || 0;
}
