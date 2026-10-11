import { createStore } from '../../../lib/store.js';

// Controla el formulario de cliente para abrirlo desde cualquier pantalla
export const clientSheets = createStore({ form: false, editing: null });
export const openNewClient = () => clientSheets.set({ form: true, editing: null });
