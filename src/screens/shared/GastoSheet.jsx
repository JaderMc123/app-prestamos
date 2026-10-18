import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { session, canWrite } from '../../lib/session.js';
import { message } from '../../lib/api.js';
import { invalidate } from '../../lib/query.js';
import { send, uuid } from '../../lib/outbox.js';
import { uploadReceipt } from '../../lib/images.js';
import { cop, parseCop } from '../../lib/money.js';
import { todayISO, addDays } from '../../lib/dates.js';
import { Sheet } from '../../components/Sheet.jsx';
import { Button, Field } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { PhotoInput } from '../../components/PhotoInput.jsx';
import { toast } from '../../components/Toast.jsx';
import { SuccessBurst } from '../../components/SuccessBurst.jsx';

// Acá se registra un gasto operativo: gasolina, mecánico, repuestos, imprevistos...
export const EXPENSE_CATEGORIES = [
  { value: 'Gasolina', icon: 'route', hint: 'Tanqueo de la moto o el carro' },
  { value: 'Mecánico', icon: 'settings', hint: 'Arreglo, mantenimiento, cambio de aceite' },
  { value: 'Repuestos', icon: 'settings', hint: 'Llantas, frenos, cadena, batería' },
  { value: 'Comida', icon: 'cash', hint: 'Almuerzo o refrigerio en la ruta' },
  { value: 'Celular', icon: 'phone', hint: 'Recargas, datos, plan' },
  { value: 'Parqueadero', icon: 'pin', hint: 'Parqueo o peajes' },
  { value: 'Imprevisto', icon: 'alert', hint: 'Multa, accidente, algo que pasó' },
  { value: 'Papelería', icon: 'file', hint: 'Impresiones, talonarios' },
  { value: 'Otro', icon: 'more', hint: 'Cualquier otro gasto' }
];
export const categoryOf = (name) => EXPENSE_CATEGORIES.find((c) => c.value === name || (name === 'Moto' && c.value === 'Mecánico') || (name === 'Llanta' && c.value === 'Repuestos')) || EXPENSE_CATEGORIES[EXPENSE_CATEGORIES.length - 1];

export function GastoSheet({ open, onClose }) {
  const ctx = useStore(session, (s) => s.ctx);
  const userId = useStore(session, (s) => s.user?.id);
  const isAdmin = ctx.role === 'admin';
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [date, setDate] = useState(todayISO());
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const value = parseCop(amount);

  useEffect(() => {
    if (!open) return;
    setCategory('');
    setAmount('');
    setDesc('');
    setDate(todayISO());
    setPhoto(null);
    setDone(null);
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    if (!canWrite()) return toast('La app está en modo solo lectura hasta que se pague la suscripción.', 'error');
    if (!category) return toast('Elige en qué fue el gasto.', 'error');
    if (value <= 0) return toast('Escribe el valor del gasto.', 'error');
    if ((category === 'Otro' || category === 'Imprevisto') && !desc.trim()) return toast('Cuenta en el detalle qué pasó.', 'error');
    setBusy(true);
    try {
      let receipt = null;
      if (photo && navigator.onLine) {
        receipt = await uploadReceipt(ctx.organization.id, userId, photo).catch(() => {
          toast('No se pudo subir la foto del recibo; el gasto se guarda sin ella.', 'info');
          return null;
        });
      }
      // El admin paga de su caja; el cobrador, de la suya
      const { queued } = await send('insert_expense', {
        organization_id: ctx.organization.id,
        collector_id: isAdmin ? null : userId,
        created_by: userId,
        kind: isAdmin ? 'fijo_admin' : 'eventual_cobrador',
        category,
        description: desc.trim() || null,
        amount: value,
        expense_date: date,
        receipt_path: receipt,
        client_uuid: uuid()
      });
      invalidate('summary:');
      invalidate('admin:');
      invalidate('expenses:');
      invalidate('movements:');
      setDone({ value, queued });
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <SuccessBurst
        amount={done.value}
        title="Gasto registrado"
        detail={isAdmin ? 'Se descontó de tu caja.' : 'Se descontó de tu caja y tu administrador ya lo puede ver.'}
        queued={done.queued}
        onDone={() => {
          setDone(null);
          onClose();
        }}
      />
    );

  const cat = category && categoryOf(category);

  return (
    <Sheet open={open} onClose={onClose} title="Registrar gasto" subtitle={isAdmin ? 'Gasto de la ruta, sale de tu caja.' : 'Sale de tu caja del día.'} size="lg">
      <form class="form" onSubmit={submit}>
        <div class="cat-grid" role="radiogroup" aria-label="En qué fue el gasto" data-enter>
          {EXPENSE_CATEGORIES.map((c) => (
            <button type="button" role="radio" aria-checked={category === c.value} class={`cat-tile ${category === c.value ? 'is-active' : ''}`} onClick={() => setCategory(c.value)}>
              <Icon name={c.icon} size={20} />
              <span>{c.value}</span>
            </button>
          ))}
        </div>
        {cat && <p class="field-hint" data-enter>{cat.hint}</p>}
        <div class="amount-input" data-enter>
          <span class="amount-currency">$</span>
          <input class="amount-field num" size={Math.max(2, value.toLocaleString('es-CO').length)} inputMode="numeric" aria-label="Valor del gasto" value={value ? value.toLocaleString('es-CO') : ''} onInput={(e) => setAmount(e.currentTarget.value)} placeholder="0" />
        </div>
        <div data-enter>
          <Field label={category === 'Otro' || category === 'Imprevisto' ? '¿Qué pasó?' : 'Detalle (opcional)'} value={desc} onInput={(e) => setDesc(e.currentTarget.value)} placeholder={category === 'Mecánico' ? 'Ej. cambio de aceite y pastillas' : 'Ej. se espichó la llanta trasera'} />
        </div>
        <div class="form-row" data-enter>
          <Field label="Fecha" type="date" value={date} min={addDays(todayISO(), -7)} max={todayISO()} onInput={(e) => setDate(e.currentTarget.value)} />
          <PhotoInput label="Foto del recibo (opcional)" value={photo} onChange={setPhoto} />
        </div>
        <Button type="submit" size="lg" loading={busy} class="btn-block" icon="check">Registrar gasto {value ? cop(value) : ''}</Button>
      </form>
    </Sheet>
  );
}
