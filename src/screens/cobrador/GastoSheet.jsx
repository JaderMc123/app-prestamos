import { useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session, canWrite } from '../../lib/session.js';
import { supabase } from '../../lib/supabase.js';
import { q, message } from '../../lib/api.js';
import { invalidate } from '../../lib/query.js';
import { uuid } from '../../lib/outbox.js';
import { parseCop } from '../../lib/money.js';
import { Sheet } from '../../components/Sheet.jsx';
import { Button, Field, Pills } from '../../components/ui.jsx';
import { toast } from '../../components/Toast.jsx';

// Acá el cobrador registra un gasto de la operación (moto, llanta, gasolina...)
const CATEGORIES = [
  { value: 'Gasolina', label: 'Gasolina' },
  { value: 'Moto', label: 'Moto' },
  { value: 'Llanta', label: 'Llanta' },
  { value: 'Comida', label: 'Comida' },
  { value: 'Otro', label: 'Otro' }
];

export function GastoSheet({ open, onClose }) {
  const ctx = useStore(session, (s) => s.ctx);
  const userId = useStore(session, (s) => s.user?.id);
  const [category, setCategory] = useState('Gasolina');
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const value = parseCop(amount);

  const submit = async (e) => {
    e.preventDefault();
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    if (value <= 0) return toast('Escribe el valor del gasto.', 'error');
    setBusy(true);
    try {
      await q(
        supabase.from('expenses').insert({
          organization_id: ctx.organization.id,
          collector_id: userId,
          created_by: userId,
          kind: 'eventual_cobrador',
          category,
          description: desc || null,
          amount: value,
          client_uuid: uuid()
        })
      );
      toast('Gasto registrado. Tu administrador ya lo puede ver.');
      invalidate('summary:');
      setAmount('');
      setDesc('');
      onClose();
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Registrar gasto" subtitle="Se descuenta de tu caja.">
      <form class="form" onSubmit={submit}>
        <div data-enter><Pills label="Categoría" value={category} onChange={setCategory} options={CATEGORIES} /></div>
        <div class="amount-input" data-enter>
          <span class="amount-currency">$</span>
          <input class="amount-field num" size={Math.max(2, value.toLocaleString("es-CO").length)} inputMode="numeric" aria-label="Valor del gasto" value={value ? value.toLocaleString('es-CO') : ''} onInput={(e) => setAmount(e.currentTarget.value)} placeholder="0" />
        </div>
        <div data-enter><Field label="Detalle (opcional)" value={desc} onInput={(e) => setDesc(e.currentTarget.value)} placeholder="Ej. se espichó la llanta trasera" /></div>
        <Button type="submit" size="lg" loading={busy} class="btn-block">Registrar gasto</Button>
      </form>
    </Sheet>
  );
}
