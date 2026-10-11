// Genera una contraseña fácil de dictar (palabra + número)
const WORDS = ['Ruta', 'Cobro', 'Norte', 'Sol', 'Moto', 'Cafe', 'Rio', 'Monte', 'Llano', 'Palma'];

export function suggestPassword() {
  const w = WORDS[Math.floor(Math.random() * WORDS.length)];
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 9000;
  return `${w}-${1000 + n}`;
}
