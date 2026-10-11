import { createStore } from '../../lib/store.js';

// Controla el panel de "Nuevo cobrador" para abrirlo desde el botón central
export const adminSheets = createStore({ newCollector: false });
export const openNewCollector = () => adminSheets.set({ newCollector: true });
