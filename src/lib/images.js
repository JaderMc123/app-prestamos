import { supabase } from './supabase.js';

// Acá se comprimen las fotos (cédula, cliente, firma) antes de subirlas, para gastar pocos datos
export function compressImage(file, { max = 1280, quality = 0.72 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo procesar la foto'))), 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la foto'));
    };
    img.src = url;
  });
}

// Fotos pendientes guardadas en el teléfono (IndexedDB) mientras no hay señal
const DB = 'fotos-pendientes';
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('fotos');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePending(key, value) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('fotos', 'readwrite');
    tx.objectStore('fotos').put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function takePending(key) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('fotos', 'readwrite');
    const store = tx.objectStore('fotos');
    const get = store.get(key);
    get.onsuccess = () => {
      store.delete(key);
      res(get.result || null);
    };
    tx.onerror = () => rej(tx.error);
  });
}

// Sube las fotos del cliente al almacenamiento privado y guarda las rutas en su ficha
const FIELD = { front: 'id_front_path', back: 'id_back_path', photo: 'photo_path', consent: 'data_consent_path', signature: 'data_consent_signature_path' };

export async function uploadClientPhotos(orgId, clientId, photos) {
  const patch = {};
  for (const [kind, blob] of Object.entries(photos || {})) {
    if (!blob || !FIELD[kind]) continue;
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    const path = `${orgId}/${clientId}/${kind}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('client-documents').upload(path, blob, { contentType: blob.type, upsert: true });
    if (error) throw error;
    patch[FIELD[kind]] = path;
  }
  if (Object.keys(patch).length) {
    const { error } = await supabase.from('clients').update(patch).eq('id', clientId);
    if (error) throw error;
  }
}

export async function signedUrl(path) {
  if (!path) return null;
  const { data } = await supabase.storage.from('client-documents').createSignedUrl(path, 600);
  return data?.signedUrl || null;
}
