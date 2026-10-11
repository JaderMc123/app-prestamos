import { useEffect, useState } from 'preact/hooks';
import { compressImage } from '../lib/images.js';
import { Icon } from './Icon.jsx';
import { toast } from './Toast.jsx';

// Botón para tomar o elegir una foto; la comprime y muestra una vista previa
export function PhotoInput({ label, value, onChange }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!value) return setPreview(null);
    const url = URL.createObjectURL(value);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  const pick = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try {
      onChange(await compressImage(file));
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <label class={`photo-input ${preview ? 'has-photo' : ''}`}>
      <input type="file" accept="image/*" capture="environment" class="sr-only" onChange={pick} />
      {preview ? <img src={preview} alt={label} /> : <Icon name="plus" size={22} />}
      <span>{preview ? 'Cambiar' : label}</span>
    </label>
  );
}
