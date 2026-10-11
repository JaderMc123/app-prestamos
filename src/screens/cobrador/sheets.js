import { createStore } from '../../lib/store.js';

// Controla qué panel del cobrador está abierto (cobrar o gasto)
export const sheets = createStore({ cobrar: false, preset: null, gasto: false });
export const openCobrar = (preset = null) => sheets.set({ cobrar: true, preset });
export const openGasto = () => sheets.set({ gasto: true });
